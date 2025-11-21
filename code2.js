/**
 * ActivityDash - Discord Server Activity Analyzer
 * Author: Keystone
 * Created: 2025-11-21
 * Version: 1.1.0
 * 
 * Quick analyzer to see who's most active in discord servers
 * Generates cool charts and stuff in the console
 */

// imports
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const readline = require('readline');
const fs = require('fs').promises;
require('dotenv').config({ debug: true });

// config stuff
const config = {
    token: 'token </>',
    messageLimit: 500,
    enableDebug: true, // turn this off in prod
    chartWidth: 50,
    topUsersCount: 10
};

// simple logging utils
const log = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    success: (msg) => console.log(`[✓] ${msg}`),
    error: (msg) => console.error(`[✗] ${msg}`),
    warn: (msg) => console.log(`[⚠️] ${msg}`),
    progress: (msg) => process.stdout.write(`\r${msg}`),
    debug: (msg) => config.enableDebug && console.log(`[DEBUG] ${msg}`)
};

/**
 * Main analyzer class
 * Does all the heavy lifting for fetching and analyzing messages
 */
class ActivityAnalyzer {
    constructor() {
        this.messages = [];
        this.stats = {
            totalMessages: 0,
            uniqueUsers: new Set(),
            channelActivity: new Map(),
            userActivity: new Map(),
            hourlyActivity: new Array(24).fill(0),  // 24 hours
            dailyActivity: new Map(),
            messageLengths: []
        };
    }
    
    async fetchGuildMessages(guild, limit = 100) {
        log.info(`Fetching messages from ${guild.name}...`);
        log.debug(`Guild ID: ${guild.id}, Member Count: ${guild.memberCount}`);
        
        // get the bot member first
        const botMember = guild.members.cache.get(guild.client.user.id);
        if (!botMember) {
            log.error('Bot member not found in guild cache');
            return this.messages;
        }
        
        // check what perms we have
        const botPermissions = botMember.permissions;
        log.debug(`Bot has admin: ${botPermissions.has(PermissionFlagsBits.Administrator)}`);
        log.debug(`Bot can read messages: ${botPermissions.has(PermissionFlagsBits.ReadMessageHistory)}`);
        
        // get all text channels
        const channels = guild.channels.cache.filter(c => c.isTextBased() && !c.isVoiceBased());
        log.info(`Found ${channels.size} text channels`);
        
        let totalFetched = 0;
        let successfulChannels = 0;
        let errors = [];  // track errors for debugging
        
        for (const [channelId, channel] of channels) {
            try {
                // check perms for this specific channel
                const perms = channel.permissionsFor(botMember);
                
                if (!perms) {
                    log.debug(`No permissions object for #${channel.name}`);
                    errors.push(`#${channel.name}: No permissions`);
                    continue;
                }
                
                const canView = perms.has(PermissionFlagsBits.ViewChannel);
                const canRead = perms.has(PermissionFlagsBits.ReadMessageHistory);
                
                log.debug(`#${channel.name} - View: ${canView}, Read: ${canRead}`);
                
                if (!canView || !canRead) {
                    // skip channels we cant read
                    errors.push(`#${channel.name}: Missing ${!canView ? 'ViewChannel' : 'ReadMessageHistory'} permission`);
                    continue;
                }
                
                log.progress(`Fetching from #${channel.name}... (${totalFetched} total)`);
                
                // actually fetch the messages
                let messages;
                try {
                    messages = await channel.messages.fetch({ limit: Math.min(limit, 100) }); // discord limits to 100 per request
                    log.debug(`Fetched ${messages.size} messages from #${channel.name}`);
                } catch (fetchError) {
                    log.debug(`Fetch error in #${channel.name}: ${fetchError.message}`);
                    errors.push(`#${channel.name}: ${fetchError.message}`);
                    continue;
                }
                
                if (messages.size > 0) {
                    successfulChannels++;
                }
                
                // process each message
                for (const [msgId, msg] of messages) {
                    // skip bot messages
                    if (msg.author.bot) continue;
                    
                    this.messages.push({
                        id: msg.id,
                        content: msg.content || '',
                        authorId: msg.author.id,
                        authorTag: msg.author.tag || msg.author.username, // fallback to username if no tag
                        channelId: channel.id,
                        channelName: channel.name,
                        timestamp: msg.createdTimestamp,
                        attachments: msg.attachments.size,
                        embeds: msg.embeds.length
                    });
                    
                    totalFetched++;
                }
                
            } catch (error) {
                log.debug(`Error in #${channel.name}: ${error.message}`);
                errors.push(`#${channel.name}: ${error.message}`);
            }
        }
        
        console.log(''); // clear the progress line
        
        // show what we got
        log.success(`Fetched ${totalFetched} messages from ${successfulChannels}/${channels.size} channels`);
        
        // show errors if debug is on
        if (errors.length > 0 && config.enableDebug) {
            log.warn(`Failed channels (${errors.length}):`);
            errors.forEach(err => log.debug(`  - ${err}`));
        }
        
        // if we got nothing, help the user figure out why
        if (totalFetched === 0) {
            log.warn('No messages were fetched. Possible reasons:');
            log.warn('  1. Bot lacks "Read Message History" permission');
            log.warn('  2. Channels are empty or have no recent messages');
            log.warn('  3. All messages are from bots (which are filtered)');
            log.warn('\nBot Permission Check:');
            log.warn('  Required permissions: VIEW_CHANNEL, READ_MESSAGE_HISTORY');
            log.warn('  Invite link with proper permissions:');
            console.log(`  https://discord.com/api/oauth2/authorize?client_id=${guild.client.user.id}&permissions=68608&scope=bot`);
        }
        
        return this.messages;
    }
    
    // analyze all the messages we collected
    analyze() {
        if (this.messages.length === 0) {
            log.error('No messages to analyze!');
            return false;
        }
        
        log.info(`Analyzing ${this.messages.length} messages...`);
        
        // go through each message and build stats
        for (const msg of this.messages) {
            this.stats.totalMessages++;
            this.stats.uniqueUsers.add(msg.authorId);
            
            // channel activity
            const channelCount = this.stats.channelActivity.get(msg.channelName) || 0;
            this.stats.channelActivity.set(msg.channelName, channelCount + 1);
            
            // user activity
            const userKey = msg.authorTag;
            const userCount = this.stats.userActivity.get(userKey) || 0;
            this.stats.userActivity.set(userKey, userCount + 1);
            
            // hourly breakdown
            const date = new Date(msg.timestamp);
            const hour = date.getHours();
            this.stats.hourlyActivity[hour]++;
            
            // daily activity
            const dateKey = date.toDateString();
            const dayCount = this.stats.dailyActivity.get(dateKey) || 0;
            this.stats.dailyActivity.set(dateKey, dayCount + 1);
            
            // track msg lengths for stats
            this.stats.messageLengths.push(msg.content.length);
        }
        
        log.success('Analysis complete');
        return true;
    }
    
    displayDashboard() {
        // no data? show troubleshooting
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
        
        // show the dashboard
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
    
    displayOverview() {
        console.log('\n📈 OVERVIEW');
        console.log('-'.repeat(80));
        console.log(`Total Messages:    ${this.stats.totalMessages.toLocaleString()}`);
        console.log(`Unique Users:      ${this.stats.uniqueUsers.size}`);
        console.log(`Active Channels:   ${this.stats.channelActivity.size}`);
        console.log(`Date Range:        ${this.getDateRange()}`);
    }
    
    // show which channels are most active
    displayChannelActivity() {
        console.log('\n💬 CHANNEL ACTIVITY');
        console.log('-'.repeat(80));
        
        const sorted = Array.from(this.stats.channelActivity.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);  // top 10
        
        if (sorted.length === 0) {
            console.log('No channel activity data');
            return;
        }
        
        const maxCount = sorted[0][1];
        
        for (const [channel, count] of sorted) {
            const barLength = Math.floor((count / maxCount) * config.chartWidth);
            const bar = '█'.repeat(barLength) || '▏';  // at least show something
            const percentage = ((count / this.stats.totalMessages) * 100).toFixed(1);
            
            console.log(`${channel.padEnd(20)} ${bar} ${count} (${percentage}%)`);
        }
    }
    
    // leaderboard basically
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
            const rank = `${index + 1}.`.padStart(3);
            
            // truncate long usernames
            console.log(`${rank} ${user.padEnd(25).slice(0, 25)} ${bar} ${count}`);
        });
    }
    
    // cool heatmap showing when ppl are most active
    displayHourlyHeatmap() {
        console.log('\n🕐 HOURLY ACTIVITY HEATMAP');
        console.log('-'.repeat(80));
        
        const maxActivity = Math.max(...this.stats.hourlyActivity);
        
        if (maxActivity === 0) {
            console.log('No hourly activity data');
            return;
        }
        
        // display as 4x6 grid (24 hours)
        for (let row = 0; row < 4; row++) {
            let line = '';
            for (let col = 0; col < 6; col++) {
                const hour = row * 6 + col;
                const count = this.stats.hourlyActivity[hour];
                const intensity = count / maxActivity;
                
                // pick character based on intensity
                let char = ' ';
                if (intensity > 0.75) char = '█';
                else if (intensity > 0.5) char = '▓';
                else if (intensity > 0.25) char = '▒';
                else if (intensity > 0) char = '░';
                
                const hourStr = `${hour}`.padStart(2, '0');
                line += `${hourStr}:${char.repeat(3)} `;
            }
            console.log(line);
        }
        
        console.log('\nLegend: █ Very High  ▓ High  ▒ Medium  ░ Low');
    }
    
    displayMessageStats() {
        console.log('\n📝 MESSAGE STATISTICS');
        console.log('-'.repeat(80));
        
        if (this.stats.messageLengths.length === 0) {
            console.log('No message data');
            return;
        }
        
        const lengths = [...this.stats.messageLengths].sort((a, b) => a - b);
        const sum = lengths.reduce((a, b) => a + b, 0);
        const avg = sum / lengths.length;
        const median = lengths[Math.floor(lengths.length / 2)];
        const max = Math.max(...lengths);
        const min = Math.min(...lengths);
        
        console.log(`Average Length:    ${avg.toFixed(1)} characters`);
        console.log(`Median Length:     ${median} characters`);
        console.log(`Shortest:          ${min} characters`);
        console.log(`Longest:           ${max} characters`);
    }
    
    // helper to get date range of messages
    getDateRange() {
        if (this.messages.length === 0) return 'N/A';
        
        const timestamps = this.messages.map(m => m.timestamp);
        const oldest = new Date(Math.min(...timestamps));
        const newest = new Date(Math.max(...timestamps));
        
        return `${oldest.toLocaleDateString()} - ${newest.toLocaleDateString()}`;
    }
    
    // export stats to json file
    async exportToFile(filename) {
        const exportData = {
            generatedAt: new Date().toISOString(),
            overview: {
                totalMessages: this.stats.totalMessages,
                uniqueUsers: this.stats.uniqueUsers.size,
                activeChannels: this.stats.channelActivity.size
            },
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
 * CLI interface for the analyzer
 * Handles user input and bot connection
 */
class ActivityCLI {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers  // need this for member counts
            ]
        });
        
        this.analyzer = new ActivityAnalyzer();
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }
    
    async initialize() {
        log.info('Logging into Discord...');
        
        // setup ready handler
        this.client.once('ready', () => {
            log.success(`Logged in as ${this.client.user.tag}`);
            log.debug(`Bot ID: ${this.client.user.id}`);
            log.debug(`Guilds in cache: ${this.client.guilds.cache.size}`);
        });
        
        try {
            await this.client.login(config.token);
            // wait for ready event
            await new Promise((resolve) => {
                if (this.client.isReady()) resolve();
                else this.client.once('ready', resolve);
            });
        } catch (error) {
            log.error(`Failed to login: ${error.message}`);
            
            // help user debug common issues
            if (error.message.includes('TOKEN_INVALID')) {
                log.error('The provided token is invalid. Please check your .env file.');
            } else if (error.message.includes('DISALLOWED_INTENTS')) {
                log.error('Bot is missing required intents. Enable them in Discord Developer Portal.');
            }
            
            process.exit(1);
        }
    }
    
    async start() {
        console.log(`
╔════════════════════════════════════════╗
║  ActivityDash v1.0.0                   ║
║  Discord Activity Analyzer             ║
╚════════════════════════════════════════╝
        `);
        
        // make sure we have guilds loaded
        await this.client.guilds.fetch();
        const guilds = this.client.guilds.cache;
        
        // list servers
        console.log('\nAvailable Servers:');
        const guildArray = [];
        
        for (const [id, guild] of guilds) {
            // try to get full guild data
            let fullGuild = guild;
            if (!guild.memberCount) {
                try {
                    fullGuild = await guild.fetch();
                } catch (e) {
                    log.debug(`Could not fetch guild ${id}: ${e.message}`);
                }
            }
            guildArray.push(fullGuild);
            console.log(`  ${guildArray.length}. ${fullGuild.name} (${fullGuild.memberCount || '?'} members)`);
        }
        
        // ask user to pick one
        const selection = await this.prompt('\nSelect server number (or "q" to quit): ');
        
        if (selection.toLowerCase() === 'q') {
            await this.cleanup();
            return;
        }
        
        const selectedGuild = guildArray[parseInt(selection) - 1];
        
        if (!selectedGuild) {
            log.error('Invalid selection');
            await this.cleanup();
            return;
        }
        
        // ask for message limit
        const messageLimit = await this.prompt(`Messages per channel (default ${config.messageLimit}): `);
        const limit = parseInt(messageLimit) || config.messageLimit;
        
        // do the actual work
        await this.analyzer.fetchGuildMessages(selectedGuild, limit);
        const analyzed = this.analyzer.analyze();
        
        if (analyzed) {
            this.analyzer.displayDashboard();
            
            // offer export
            const shouldExport = await this.prompt('\nExport to JSON? (y/n): ');
            if (shouldExport.toLowerCase() === 'y') {
                const filename = `activity_${selectedGuild.id}_${Date.now()}.json`;
                await this.analyzer.exportToFile(filename);
            }
        } else {
            this.analyzer.displayDashboard(); // shows troubleshooting tips
        }
        
        await this.cleanup();
    }
    
    // helper for user input
    prompt(question) {
        return new Promise(resolve => {
            this.rl.question(question, resolve);
        });
    }
    
    // cleanup and exit
    async cleanup() {
        this.rl.close();
        await this.client.destroy();
        log.info('Goodbye!');
        process.exit(0);
    }
}

// main entry point
if (require.main === module) {
    const cli = new ActivityCLI();
    
    cli.initialize()
        .then(() => cli.start())
        .catch(error => {
            log.error(`Fatal error: ${error.message}`);
            if (error.stack && config.enableDebug) {
                console.error(error.stack);
            }
            process.exit(1);
        });
    
    // handle ctrl+c gracefully
    process.on('SIGINT', async () => {
        console.log('\n\nShutting down...');
        process.exit(0);
    });
    
    process.on('unhandledRejection', (error) => {
        log.error(`Unhandled rejection: ${error?.message || error}`);
        if (config.enableDebug && error?.stack) {
            console.error(error.stack);
        }
    });
}

module.exports = { ActivityAnalyzer, ActivityCLI };
