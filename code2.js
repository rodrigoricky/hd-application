/**
 * ActivityDash - Discord Server Activity Analyzer
 * Author: Keystone
 * Created: 2025-11-21
 * Version: 1.1.0
 * 
 * Quick analyzer to see who's most active in discord servers
 * Generates cool charts and stuff in the console
 * 
 * === Architecture Overview ===
 * 
 * this started as a single-file script that just counted messages.
 * worked fine until i wanted to reuse the analysis logic for multiple
 * servers without reconnecting the bot each time. ended up splitting
 * into two classes with clear boundaries:
 * 
 * ActivityAnalyzer (data layer)
 *    └→ fetches messages, crunches numbers, displays results
 *    └→ knows nothing about discord.js client management or CLI
 *    └→ could be imported and used in a web dashboard or bot command
 * 
 * ActivityCLI (interface layer)
 *    └→ handles bot connection, user prompts, cleanup
 *    └→ just pipes discord data into the analyzer
 *    └→ keeps all the readline/process stuff separate
 * 
 * why CLI instead of a bot command?
 * - tried slash commands first but the output was too long for discord messages
 * - embeds can only show so much data before hitting the 6000 char limit
 * - console charts are way easier to read than trying to format everything
 *   into discord's markdown, plus you can scroll back
 * - also means i can run this on servers where i don't have bot admin perms
 * 
 * data flow:
 *    user picks a server from the list
 *    → CLI fetches all channels in that guild
 *    → for each channel, analyzer requests last N messages
 *    → discord.js returns Collection of Message objects
 *    → analyzer extracts the data we care about into simple objects
 *    → stored in maps/arrays organized by what we're analyzing
 *    → display functions iterate over the organized data and draw charts
 * 
 * the permission checking took forever to get right. discord's permission
 * system is super granular - you need ViewChannel AND ReadMessageHistory,
 * and both can be overridden at the channel level. spent a whole afternoon
 * figuring out why the bot could see some channels but not read messages.
 */

const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const readline = require('readline');
const fs = require('fs').promises;
require('dotenv').config({ debug: true });

// pulled these out after tweaking them like 20 times during testing
// messageLimit started at 100, bumped to 500 when i realized most channels
// have way more history than that and 100 wasn't showing the real picture
const config = {
    token: 'token </>',
    messageLimit: 500,
    enableDebug: true,
    chartWidth: 50,  // terminal width in chars, looks good on most screens
    topUsersCount: 10  // more than 10 makes the chart too long
};

// logging utility - got tired of inconsistent console.log formats
// the component tags help when debugging - can search for [DEBUG] in terminal
const log = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    success: (msg) => console.log(`[✓] ${msg}`),
    error: (msg) => console.error(`[✗] ${msg}`),
    warn: (msg) => console.log(`[⚠️] ${msg}`),
    progress: (msg) => process.stdout.write(`\r${msg}`),  // \r overwrites current line
    debug: (msg) => config.enableDebug && console.log(`[DEBUG] ${msg}`)
};

/**
 * ActivityAnalyzer - does the actual data collection and analysis
 * 
 * separated this from the CLI stuff so i could potentially reuse it.
 * like if i wanted to make a web version, i'd just import this class
 * and feed it guild data from a different source.
 * 
 * uses Maps for most storage because:
 * - O(1) lookups when aggregating data
 * - easy to increment counts without checking if key exists first
 * - can iterate in insertion order (useful for chronological stuff)
 * 
 * Arrays are only used for the hourly activity because it's a fixed
 * 24-element structure where index = hour. simpler than a Map for that.
 */
class ActivityAnalyzer {
    constructor() {
        // raw message data - just the fields we care about
        // originally stored the full Message objects but that was eating memory
        // when analyzing large servers. trimmed it down to just what we need.
        this.messages = [];
        
        // all the stats we track
        // decided on these after looking at what other analytics tools show
        // and what i personally wanted to know about my servers
        this.stats = {
            totalMessages: 0,
            uniqueUsers: new Set(),  // Set auto-dedupes user IDs
            channelActivity: new Map(),  // channel name → message count
            userActivity: new Map(),  // user tag → message count
            hourlyActivity: new Array(24).fill(0),  // index = hour of day
            dailyActivity: new Map(),  // date string → message count
            messageLengths: []  // for calculating average/median
        };
    }
    
    // the big function - fetches messages from all accessible channels
    // 
    // discord's permission system is a nightmare. you need multiple permissions
    // AND they can be overridden per channel. learned this the hard way when
    // the bot would work in some channels but silently fail in others.
    // 
    // also discord limits message fetches to 100 at a time. if you want more
    // you have to paginate with the 'before' parameter. didn't implement that
    // because 100 per channel is usually enough for recent activity analysis.
    async fetchGuildMessages(guild, limit = 100) {
        log.info(`Fetching messages from ${guild.name}...`);
        log.debug(`Guild ID: ${guild.id}, Member Count: ${guild.memberCount}`);
        
        // get bot's member object - needed for permission checks
        // this can fail if the guild isn't fully cached, hence the check
        const botMember = guild.members.cache.get(guild.client.user.id);
        if (!botMember) {
            log.error('Bot member not found in guild cache');
            return this.messages;
        }
        
        // log bot's guild-level permissions for debugging
        // these are the baseline permissions, but channels can override them
        const botPermissions = botMember.permissions;
        log.debug(`Bot has admin: ${botPermissions.has(PermissionFlagsBits.Administrator)}`);
        log.debug(`Bot can read messages: ${botPermissions.has(PermissionFlagsBits.ReadMessageHistory)}`);
        
        // filter for text channels only
        // isTextBased includes text channels, news channels, threads
        // !isVoiceBased excludes voice channels (which have text chat but we skip those)
        const channels = guild.channels.cache.filter(c => c.isTextBased() && !c.isVoiceBased());
        log.info(`Found ${channels.size} text channels`);
        
        let totalFetched = 0;
        let successfulChannels = 0;
        let errors = [];  // track which channels failed and why
        
        // iterate each channel and try to fetch messages
        // can't parallelize this too much or we hit rate limits
        // tried Promise.all() and got 429s constantly, so back to sequential
        for (const [channelId, channel] of channels) {
            try {
                // check permissions for THIS specific channel
                // this is the gotcha - guild perms don't matter if channel overrides them
                const perms = channel.permissionsFor(botMember);
                
                if (!perms) {
                    // shouldn't happen but i've seen it in weird edge cases
                    log.debug(`No permissions object for #${channel.name}`);
                    errors.push(`#${channel.name}: No permissions`);
                    continue;
                }
                
                // need BOTH of these to read message history
                // ViewChannel = can see the channel exists
                // ReadMessageHistory = can actually fetch old messages
                const canView = perms.has(PermissionFlagsBits.ViewChannel);
                const canRead = perms.has(PermissionFlagsBits.ReadMessageHistory);
                
                log.debug(`#${channel.name} - View: ${canView}, Read: ${canRead}`);
                
                if (!canView || !canRead) {
                    // skip and track why for the error report at the end
                    errors.push(`#${channel.name}: Missing ${!canView ? 'ViewChannel' : 'ReadMessageHistory'} permission`);
                    continue;
                }
                
                // show progress - important for large servers with lots of channels
                // \r makes it overwrite the same line instead of spamming the console
                log.progress(`Fetching from #${channel.name}... (${totalFetched} total)`);
                
                // actually fetch messages from discord
                // wrapped in try/catch because this can fail for various reasons:
                // - channel was deleted mid-fetch
                // - permissions changed mid-fetch
                // - rate limit (shouldn't happen with sequential but just in case)
                let messages;
                try {
                    // discord limits to 100 per request, so we cap at that
                    // could implement pagination but it's slow and 100 is usually enough
                    messages = await channel.messages.fetch({ limit: Math.min(limit, 100) });
                    log.debug(`Fetched ${messages.size} messages from #${channel.name}`);
                } catch (fetchError) {
                    log.debug(`Fetch error in #${channel.name}: ${fetchError.message}`);
                    errors.push(`#${channel.name}: ${fetchError.message}`);
                    continue;
                }
                
                if (messages.size > 0) {
                    successfulChannels++;
                }
                
                // process each message and extract what we need
                // storing minimal data instead of full Message objects to save memory
                for (const [msgId, msg] of messages) {
                    // filter out bots - they skew the stats and aren't real activity
                    // originally included them and the charts were dominated by webhook spam
                    if (msg.author.bot) continue;
                    
                    this.messages.push({
                        id: msg.id,
                        content: msg.content || '',  // can be empty for attachment-only messages
                        authorId: msg.author.id,
                        // author.tag is deprecated but some bots don't have username yet
                        authorTag: msg.author.tag || msg.author.username,
                        channelId: channel.id,
                        channelName: channel.name,
                        timestamp: msg.createdTimestamp,  // epoch ms, easier to work with than Date
                        attachments: msg.attachments.size,
                        embeds: msg.embeds.length
                    });
                    
                    totalFetched++;
                }
                
            } catch (error) {
                // outer catch for unexpected errors during channel processing
                log.debug(`Error in #${channel.name}: ${error.message}`);
                errors.push(`#${channel.name}: ${error.message}`);
            }
        }
        
        console.log(''); // newline after the progress indicator
        
        log.success(`Fetched ${totalFetched} messages from ${successfulChannels}/${channels.size} channels`);
        
        // if debug mode is on, show which channels failed and why
        // super useful when troubleshooting permission issues
        if (errors.length > 0 && config.enableDebug) {
            log.warn(`Failed channels (${errors.length}):`);
            errors.forEach(err => log.debug(`  - ${err}`));
        }
        
        // if we got literally nothing, help the user figure out why
        // this was born from frustration when testing - spent 20 minutes wondering
        // why nothing was showing until i realized i forgot to enable message content intent
        if (totalFetched === 0) {
            log.warn('No messages were fetched. Possible reasons:');
            log.warn('  1. Bot lacks "Read Message History" permission');
            log.warn('  2. Channels are empty or have no recent messages');
            log.warn('  3. All messages are from bots (which are filtered)');
            log.warn('\nBot Permission Check:');
            log.warn('  Required permissions: VIEW_CHANNEL, READ_MESSAGE_HISTORY');
            log.warn('  Invite link with proper permissions:');
            // 68608 = READ_MESSAGE_HISTORY + VIEW_CHANNEL in decimal
            console.log(`  https://discord.com/api/oauth2/authorize?client_id=${guild.client.user.id}&permissions=68608&scope=bot`);
        }
        
        return this.messages;
    }
    
    // crunch the numbers on all the messages we collected
    // 
    // separated this from fetching because:
    // 1. clean separation of concerns (fetch vs analyze)
    // 2. could fetch from multiple guilds then analyze together
    // 3. easier to test - can feed it mock data
    // 
    // returns bool so the CLI knows whether to show the dashboard or troubleshooting
    analyze() {
        if (this.messages.length === 0) {
            log.error('No messages to analyze!');
            return false;
        }
        
        log.info(`Analyzing ${this.messages.length} messages...`);
        
        // single pass through all messages to build all stats
        // could do multiple passes but that's wasteful when dealing with thousands of messages
        for (const msg of this.messages) {
            this.stats.totalMessages++;
            
            // Set automatically handles deduplication
            this.stats.uniqueUsers.add(msg.authorId);
            
            // channel activity tracking
            // Map.get returns undefined if key doesn't exist, so we default to 0
            const channelCount = this.stats.channelActivity.get(msg.channelName) || 0;
            this.stats.channelActivity.set(msg.channelName, channelCount + 1);
            
            // user activity tracking - using tag instead of id for readable display
            const userKey = msg.authorTag;
            const userCount = this.stats.userActivity.get(userKey) || 0;
            this.stats.userActivity.set(userKey, userCount + 1);
            
            // hourly activity - extract hour from timestamp
            // this gives us the heatmap of when people are most active
            const date = new Date(msg.timestamp);
            const hour = date.getHours();  // 0-23
            this.stats.hourlyActivity[hour]++;
            
            // daily activity - group by date string
            // toDateString gives "Mon Jan 01 2024" which is good enough for grouping
            const dateKey = date.toDateString();
            const dayCount = this.stats.dailyActivity.get(dateKey) || 0;
            this.stats.dailyActivity.set(dateKey, dayCount + 1);
            
            // track message lengths for statistical analysis
            // wanted to see average/median message length out of curiosity
            this.stats.messageLengths.push(msg.content.length);
        }
        
        log.success('Analysis complete');
        return true;
    }
    
    // main display function - calls all the sub-displays
    // organized as separate methods because each chart is complex enough
    // to warrant its own function
    displayDashboard() {
        // if we have no data, show troubleshooting instead of empty charts
        // learned this from user testing - people were confused by blank output
        if (this.stats.totalMessages === 0) {
            console.log('\n' + '='.repeat(80));
            console.log('⚠️  NO DATA TO DISPLAY');
            console.log('='.repeat(80));
            console.log('\nTroubleshooting steps:');
            console.log('1. Ensure the bot has these permissions in your server:');
            console.log('   ✓ View Channels');
            console.log('   ✓ Read Message History');
            console.log('   ✓ Read Messages');
            console.log('\n2. Check that the channels have messages');
            console.log('3. Try increasing the message limit');
            console.log('4. Make sure channels aren\'t restricted\n');
            return;
        }
        
        // display all the sections
        console.log('\n' + '='.repeat(80));
        console.log('📊 DISCORD ACTIVITY DASHBOARD');
        console.log('='.repeat(80));
        
        this.displayOverview();
        this.displayChannelActivity();
        this.displayTopUsers();
        this.displayHourlyHeatmap();
        this.displayMessageStats();
        
        console.log('='.repeat(80) + '\n');
    }
    
    // basic stats at the top
    // intentionally simple - just the key numbers
    displayOverview() {
        console.log('\n📈 OVERVIEW');
        console.log('-'.repeat(80));
        console.log(`Total Messages:    ${this.stats.totalMessages.toLocaleString()}`);
        console.log(`Unique Users:      ${this.stats.uniqueUsers.size}`);
        console.log(`Active Channels:   ${this.stats.channelActivity.size}`);
        console.log(`Date Range:        ${this.getDateRange()}`);
    }
    
    // horizontal bar chart showing channel activity
    // 
    // originally tried vertical bars but they were hard to read in the console.
    // horizontal makes it easy to align the channel names and see at a glance
    // which channels are busiest.
    // 
    // the bars are normalized to the max value - makes them always fill the width
    // regardless of absolute message counts. easier to compare visually.
    displayChannelActivity() {
        console.log('\n💬 CHANNEL ACTIVITY');
        console.log('-'.repeat(80));
        
        // sort by message count descending, take top 10
        // more than 10 gets too long and the tail isn't interesting anyway
        const sorted = Array.from(this.stats.channelActivity.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        
        if (sorted.length === 0) {
            console.log('No channel activity data');
            return;
        }
        
        // find the max for normalization
        const maxCount = sorted[0][1];
        
        for (const [channel, count] of sorted) {
            // calculate bar length proportional to max
            const barLength = Math.floor((count / maxCount) * config.chartWidth);
            // █ is the full block character, ▏ is a thin one for tiny values
            const bar = '█'.repeat(barLength) || '▏';
            const percentage = ((count / this.stats.totalMessages) * 100).toFixed(1);
            
            // padEnd aligns everything nicely in columns
            console.log(`${channel.padEnd(20)} ${bar} ${count} (${percentage}%)`);
        }
    }
    
    // leaderboard of most active users
    // same concept as channel activity but for users
    displayTopUsers() {
        console.log('\n👥 TOP ACTIVE USERS');
        console.log('-'.repeat(80));
        
        const sorted = Array.from(this.stats.userActivity.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, config.topUsersCount);
        
        if (sorted.length === 0) {
            console.log('No user activity data');
            return;
        }
        
        const maxCount = sorted[0][1];
        
        sorted.forEach(([user, count], index) => {
            const barLength = Math.floor((count / maxCount) * config.chartWidth);
            const bar = '█'.repeat(barLength) || '▏';
            const rank = `${index + 1}.`.padStart(3);  // "1. ", "2. ", etc
            
            // slice(0, 25) truncates long usernames so they don't break the formatting
            // discord names can be really long with all the special characters people use
            console.log(`${rank} ${user.padEnd(25).slice(0, 25)} ${bar} ${count}`);
        });
    }
    
    // this was the most fun to build - a heatmap showing activity by hour
    // 
    // wanted to see when people are most active. tried a few formats:
    // - list of hours with counts: boring and hard to see patterns
    // - vertical bar chart: took too much vertical space
    // - this grid with intensity shading: perfect, shows patterns at a glance
    // 
    // using block characters with different densities to show intensity.
    // full block = very active, spaces = quiet hours.
    displayHourlyHeatmap() {
        console.log('\n🕐 HOURLY ACTIVITY HEATMAP');
        console.log('-'.repeat(80));
        
        const maxActivity = Math.max(...this.stats.hourlyActivity);
        
        if (maxActivity === 0) {
            console.log('No hourly activity data');
            return;
        }
        
        // display as a 4x6 grid (4 rows, 6 columns = 24 hours)
        // each cell shows the hour and a visual indicator of activity level
        for (let row = 0; row < 4; row++) {
            let line = '';
            for (let col = 0; col < 6; col++) {
                const hour = row * 6 + col;
                const count = this.stats.hourlyActivity[hour];
                
                // normalize to 0-1 range
                const intensity = count / maxActivity;
                
                // pick block character based on intensity
                // these are unicode block characters with increasing density
                let char = ' ';
                if (intensity > 0.75) char = '█';      // solid
                else if (intensity > 0.5) char = '▓';  // dark shade
                else if (intensity > 0.25) char = '▒'; // medium shade
                else if (intensity > 0) char = '░';    // light shade
                
                // format hour as two digits (00, 01, 02...)
                const hourStr = `${hour}`.padStart(2, '0');
                // repeat the char 3 times to make each cell wider - easier to see
                line += `${hourStr}:${char.repeat(3)} `;
            }
            console.log(line);
        }
        
        console.log('\nLegend: █ Very High  ▓ High  ▒ Medium  ░ Low');
    }
    
    // message length statistics
    // added this because i was curious about message length patterns
    // turns out most servers have very short messages (5-20 chars)
    displayMessageStats() {
        console.log('\n📝 MESSAGE STATISTICS');
        console.log('-'.repeat(80));
        
        if (this.stats.messageLengths.length === 0) {
            console.log('No message data');
            return;
        }
        
        // calculate basic stats
        // need to sort for median calculation
        const lengths = [...this.stats.messageLengths].sort((a, b) => a - b);
        const sum = lengths.reduce((a, b) => a + b, 0);
        const avg = sum / lengths.length;
        
        // median is the middle value when sorted
        // more useful than average for skewed distributions (which message lengths are)
        const median = lengths[Math.floor(lengths.length / 2)];
        
        const max = Math.max(...lengths);
        const min = Math.min(...lengths);
        
        console.log(`Average Length:    ${avg.toFixed(1)} characters`);
        console.log(`Median Length:     ${median} characters`);
        console.log(`Shortest:          ${min} characters`);
        console.log(`Longest:           ${max} characters`);
    }
    
    // helper to show the date range of analyzed messages
    // gives context to the stats - "are these messages from today or last week?"
    getDateRange() {
        if (this.messages.length === 0) return 'N/A';
        
        const timestamps = this.messages.map(m => m.timestamp);
        const oldest = new Date(Math.min(...timestamps));
        const newest = new Date(Math.max(...timestamps));
        
        return `${oldest.toLocaleDateString()} - ${newest.toLocaleDateString()}`;
    }
    
    // export to JSON for further analysis in other tools
    // originally included the full message array but that was huge
    // trimmed to just the aggregated stats
    async exportToFile(filename) {
        const exportData = {
            generatedAt: new Date().toISOString(),
            overview: {
                totalMessages: this.stats.totalMessages,
                uniqueUsers: this.stats.uniqueUsers.size,
                activeChannels: this.stats.channelActivity.size
            },
            // Maps need to be converted to objects for JSON
            channelActivity: Object.fromEntries(this.stats.channelActivity),
            topUsers: Object.fromEntries(
                Array.from(this.stats.userActivity.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, config.topUsersCount)
            ),
            hourlyActivity: this.stats.hourlyActivity
        };
        
        await fs.writeFile(filename, JSON.stringify(exportData, null, 2));
        log.success(`Exported statistics to ${filename}`);
    }
}

/**
 * ActivityCLI - handles user interaction and bot lifecycle
 * 
 * separated from the analyzer because they have different concerns:
 * - CLI: managing discord connection, prompting user, cleanup
 * - Analyzer: data collection and processing
 * 
 * this split means the analyzer is reusable. could import it into
 * a web server or make it a bot command without rewriting anything.
 * 
 * the CLI just acts as a thin wrapper that:
 * 1. connects to discord
 * 2. shows available servers
 * 3. passes selected server to analyzer
 * 4. cleans up and exits
 * 
 * readline is surprisingly tricky to work with. had issues with the
 * interface not closing properly and the process hanging. that's why
 * there's explicit cleanup everywhere.
 */
class ActivityCLI {
    constructor() {
        // discord client with all the intents we need
        // MessageContent is required to read message text (added in 2022)
        // GuildMembers for getting accurate member counts
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers
            ]
        });
        
        this.analyzer = new ActivityAnalyzer();
        
        // readline for getting user input
        // stdio because we're reading from console
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }
    
    // connect to discord and wait for ready
    // 
    // discord.js connection is async and event-based which is annoying
    // for a CLI tool. we need to await login() AND wait for the ready event
    // before we can do anything. that's what the promise stuff handles.
    async initialize() {
        log.info('Logging into Discord...');
        
        // setup ready handler before login so we don't miss the event
        this.client.once('ready', () => {
            log.success(`Logged in as ${this.client.user.tag}`);
            log.debug(`Bot ID: ${this.client.user.id}`);
            log.debug(`Guilds in cache: ${this.client.guilds.cache.size}`);
        });
        
        try {
            await this.client.login(config.token);
            
            // login() resolves when websocket connects, but we need to wait
            // for the ready event before the cache is populated
            // this promise waits for ready or resolves immediately if already ready
            await new Promise((resolve) => {
                if (this.client.isReady()) resolve();
                else this.client.once('ready', resolve);
            });
            
        } catch (error) {
            log.error(`Failed to login: ${error.message}`);
            
            // common error cases - help the user fix them
            // these are the errors i ran into the most during dev
            if (error.message.includes('TOKEN_INVALID')) {
                log.error('The provided token is invalid. Please check your .env file.');
            } else if (error.message.includes('DISALLOWED_INTENTS')) {
                log.error('Bot is missing required intents. Enable them in Discord Developer Portal.');
                log.error('Required: MESSAGE CONTENT INTENT, SERVER MEMBERS INTENT');
            }
            
            process.exit(1);
        }
    }
    
    // main CLI flow - show servers, get selection, analyze, export
    async start() {
        console.log(`
╔════════════════════════════════════════╗
║  ActivityDash v1.0.0                   ║
║  Discord Activity Analyzer             ║
╚════════════════════════════════════════╝
        `);
        
        // fetch all guilds the bot is in
        // the cache might not have full data yet so we force a fetch
        await this.client.guilds.fetch();
        const guilds = this.client.guilds.cache;
        
        // list available servers with member counts
        console.log('\nAvailable Servers:');
        const guildArray = [];
        
        for (const [id, guild] of guilds) {
            // guild from cache might be partial - fetch full data
            // this gets us accurate member counts and channel info
            let fullGuild = guild;
            if (!guild.memberCount) {
                try {
                    fullGuild = await guild.fetch();
                } catch (e) {
                    // if fetch fails, just use what we have
                    // this can happen if the bot was removed from the server
                    log.debug(`Could not fetch guild ${id}: ${e.message}`);
                }
            }
            
            guildArray.push(fullGuild);
            console.log(`  ${guildArray.length}. ${fullGuild.name} (${fullGuild.memberCount || '?'} members)`);
        }
        
        // get user's selection
        const selection = await this.prompt('\nSelect server number (or "q" to quit): ');
        
        if (selection.toLowerCase() === 'q') {
            await this.cleanup();
            return;
        }
        
        // parse selection as 1-indexed (humans count from 1)
        const selectedGuild = guildArray[parseInt(selection) - 1];
        
        if (!selectedGuild) {
            log.error('Invalid selection');
            await this.cleanup();
            return;
        }
        
        // ask how many messages to fetch per channel
        // giving user control because large servers can take a while
        const messageLimit = await this.prompt(`Messages per channel (default ${config.messageLimit}): `);
        const limit = parseInt(messageLimit) || config.messageLimit;
        
        // do the actual work - fetch and analyze
        await this.analyzer.fetchGuildMessages(selectedGuild, limit);
        const analyzed = this.analyzer.analyze();
        
        if (analyzed) {
            // we have data - show the dashboard
            this.analyzer.displayDashboard();
            
            // offer to export as JSON
            // useful if they want to process the data further
            const shouldExport = await this.prompt('\nExport to JSON? (y/n): ');
            if (shouldExport.toLowerCase() === 'y') {
                const filename = `activity_${selectedGuild.id}_${Date.now()}.json`;
                await this.analyzer.exportToFile(filename);
            }
        } else {
            // no data - displayDashboard shows troubleshooting info
            this.analyzer.displayDashboard();
        }
        
        await this.cleanup();
    }
    
    // helper to prompt user and wait for input
    // wraps readline.question in a promise for cleaner async/await usage
    prompt(question) {
        return new Promise(resolve => {
            this.rl.question(question, resolve);
        });
    }
    
    // clean up resources and exit
    // important to close readline and destroy the client or the process hangs
    async cleanup() {
        this.rl.close();  // close readline interface
        await this.client.destroy();  // disconnect from discord
        log.info('Goodbye!');
        process.exit(0);
    }
}

// entry point - only runs if this file is executed directly
// require.main === module is false when imported as a module
if (require.main === module) {
    const cli = new ActivityCLI();
    
    // initialize and start
    // wrapping in catch handles any uncaught errors gracefully
    cli.initialize()
        .then(() => cli.start())
        .catch(error => {
            log.error(`Fatal error: ${error.message}`);
            if (error.stack && config.enableDebug) {
                console.error(error.stack);
            }
            process.exit(1);
        });
    
    // handle ctrl+c gracefully instead of dumping stack trace
    // users don't need to see a scary error when they just want to quit
    process.on('SIGINT', async () => {
        console.log('\n\nShutting down...');
        process.exit(0);
    });
    
    // catch unhandled promise rejections
    // these can happen with discord.js if websocket dies unexpectedly
    process.on('unhandledRejection', (error) => {
        log.error(`Unhandled rejection: ${error?.message || error}`);
        if (config.enableDebug && error?.stack) {
            console.error(error.stack);
        }
    });
}

module.exports = { ActivityAnalyzer, ActivityCLI };
