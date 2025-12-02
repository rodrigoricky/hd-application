/**
 * ScheduleBot - Automated Message Scheduler
 * Author: Keystone
 * Created: 2025-11-21
 * Version: 0.5.8
 * 
 * Discord bot for scheduling messages. supports recurring msgs and stuff
 * Good for announcements, daily reminders, etc
 * 
 * === Architecture Overview ===
 * 
 * built this because i got tired of manually posting server announcements
 * at specific times. needed something more flexible than cron but simpler
 * than a full calendar system.
 * 
 * three main pieces:
 * 
 * TimeParser (time interpretation layer)
 *    └→ converts human-friendly strings to actual timestamps
 *    └→ separate class because time parsing is surprisingly complex
 *    └→ supports three schedule patterns (explained below)
 * 
 * ScheduleManager (core scheduling engine)
 *    └→ stores schedules, runs the check loop, handles execution
 *    └→ uses dual-Map pattern for O(1) channel-based queries
 *    └→ manages three types of schedules with different lifecycles
 * 
 * ScheduleBot (discord interface)
 *    └→ thin wrapper translating discord commands to manager calls
 *    └→ just formats embeds and handles permissions
 * 
 * === Schedule Type System ===
 * 
 * struggled with how to model different scheduling needs. ended up with
 * three distinct types because they have fundamentally different lifecycles:
 * 
 * 'once' - fire at a specific time then delete
 *    └→ "tomorrow 3pm" - executes once, then gone
 *    └→ simple: just check nextRun, send, delete from map
 * 
 * 'recurring' - fire at the same time repeatedly  
 *    └→ "daily 9am" or "weekly monday 3pm"
 *    └→ after firing: nextRun += interval (24h or 7d)
 *    └→ stays in the map forever until user deletes
 * 
 * 'interval' - fire every N hours/minutes from creation
 *    └→ "every 2 hours" - not tied to clock time
 *    └→ after firing: nextRun = now + intervalMs
 *    └→ drifts slightly with each execution but that's ok
 * 
 * tried combining these into one type with flags but the reschedule
 * logic got messy. separate types made the check() function way cleaner.
 * 
 * === Data Flow ===
 * 
 * user types: !schedule daily 9am | Good morning!
 *    → ScheduleBot.handleCommand() splits on "|"
 *    → ScheduleManager.create() validates channel limits
 *    → TimeParser.parse() figures out it's a recurring daily schedule
 *    → calculates next 9am (today if before 9am, tomorrow if after)
 *    → stores in both Maps: schedules (by id) + channelSchedules (by channel)
 *    → persists to JSON
 * 
 * every 30 seconds:
 *    → check() scans all schedules for nextRun <= now
 *    → fetches discord channel, sends message
 *    → based on type: delete it, or reschedule next occurrence
 *    → persists updated state
 * 
 * === Why 30 Second Check Interval? ===
 * 
 * originally used 60 seconds but schedules felt laggy. tried 5 seconds
 * but it hammered the CPU for no reason. 30s is the sweet spot:
 * - accurate enough that users don't notice (31 second delay max)
 * - light on resources (2 checks per minute is nothing)
 * - if a schedule is 30 seconds late, nobody cares
 * 
 * considered event-based scheduling (setTimeout for each schedule) but
 * that breaks when you have hundreds of schedules. also doesn't survive
 * restarts - you'd need to recreate all timeouts on load.
 * 
 * the polling approach is dumber but way more reliable.
 */

const { Client, GatewayIntentBits, EmbedBuilder, ChannelType } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');

// pulled config out after changing these values a million times during testing
const config = {
    token: 'token </>',
    dataFile: './schedules.json',
    checkInterval: 30000,  // 30 sec - explained above why not 60 or 5
    maxSchedulesPerChannel: 20,  // prevents spam, also keeps list command readable
    enableDebug: true,
    timezone: 'America/New_York'  // not actually used yet but planned for v2
};

// logging helper - same pattern as my other bots
const log = {
    info: (component, msg) => {
        if (config.enableDebug) {
            console.log(`[${component}]`, msg);
        }
    },
    success: (component, msg) => {
        console.log(`[${component}] ✓`, msg);
    },
    error: (component, msg) => {
        console.log(`[${component}] ✗`, msg);
    },
    warn: (component, msg) => {
        console.log(`[${component}] ⚠`, msg);
    }
};

// custom error with error codes so handleCommand can show better messages
class ScheduleError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ScheduleError';
        this.code = code;
        this.timestamp = new Date();
    }
}

/**
 * TimeParser - the headache that is time calculation
 * 
 * why a separate class?
 * - time parsing is complex enough to deserve isolation
 * - makes testing way easier (can test parsing without touching discord)
 * - could swap in chrono-node or something fancier later without changing manager
 * 
 * why not use cron syntax?
 * - tried it at first ("0 9 * * *" for daily 9am)
 * - users HATED it. too technical, kept getting it wrong
 * - natural language is way more intuitive even if it's harder to parse
 * 
 * the regex patterns took forever. edge cases everywhere:
 * - "9am" vs "9:30am" vs "9:30 am" (space variations)
 * - "monday" vs "Monday" (case insensitive)
 * - what if they say "daily 25:00"? (invalid hour)
 * - "today 3pm" when it's already 5pm (should roll to tomorrow)
 */
class TimeParser {
    // main parse function - tries patterns in order of specificity
    // returns object with schedule type metadata
    parse(input) {
        const cleaned = input.trim().toLowerCase();
        
        // check daily recurring first - "daily 9am" or "daily at 3:30pm"
        // the "at" is optional because people type both ways
        const dailyMatch = cleaned.match(/^daily\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (dailyMatch) {
            const [_, hour, minute, meridiem] = dailyMatch;
            const time = this.parseTime(hour, minute || '0', meridiem);
            
            return {
                type: 'recurring',
                interval: 'daily',
                time: time,
                nextRun: this.getNextDailyRun(time)
            };
        }
        
        // weekly recurring - "weekly monday 9am"
        // originally supported "every monday" too but removed it to keep syntax consistent
        const weeklyMatch = cleaned.match(/^weekly\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (weeklyMatch) {
            const [_, day, hour, minute, meridiem] = weeklyMatch;
            const time = this.parseTime(hour, minute || '0', meridiem);
            
            return {
                type: 'recurring',
                interval: 'weekly',
                day: day.toLowerCase(),
                time: time,
                nextRun: this.getNextWeeklyRun(day, time)
            };
        }
        
        // one-time tomorrow - "tomorrow 3pm"
        // simpler than daily because it's always tomorrow, no rollover logic
        const tomorrowMatch = cleaned.match(/^tomorrow\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (tomorrowMatch) {
            const [_, hour, minute, meridiem] = tomorrowMatch;
            const time = this.parseTime(hour, minute || '0', meridiem);
            const nextRun = this.getTomorrowAt(time);
            
            return {
                type: 'once',
                nextRun: nextRun
            };
        }
        
        // one-time today - "today 3pm"
        // this one's tricky: if time already passed, should we fail or roll to tomorrow?
        // decided on rolling to tomorrow because it's less confusing for users
        const todayMatch = cleaned.match(/^today\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (todayMatch) {
            const [_, hour, minute, meridiem] = todayMatch;
            const time = this.parseTime(hour, minute || '0', meridiem);
            let nextRun = this.getTodayAt(time);
            
            // auto-rollover if time passed - prevents "scheduled in the past" errors
            // learned this from user complaints when they typed "today 3pm" at 4pm
            if (nextRun < Date.now()) {
                nextRun = this.getTomorrowAt(time);
                log.info('PARSER', 'Time already passed today, scheduling for tomorrow');
            }
            
            return {
                type: 'once',
                nextRun: nextRun
            };
        }
        
        // interval based - "every 2 hours", "every 30 minutes"
        // not tied to clock time - just fires every N ms from creation
        // useful for periodic checks or reminders that don't need exact timing
        const intervalMatch = cleaned.match(/^every\s+(\d+)\s+(hour|hours|minute|minutes)$/i);
        if (intervalMatch) {
            const [_, amount, unit] = intervalMatch;
            
            // convert to milliseconds
            // originally had a lookup table but inline is clearer for just two units
            const ms = unit.startsWith('hour') 
                ? parseInt(amount) * 3600000
                : parseInt(amount) * 60000;
            
            return {
                type: 'interval',
                intervalMs: ms,
                nextRun: Date.now() + ms  // first run is one interval from now
            };
        }
        
        // nothing matched - throw with helpful error message
        throw new ScheduleError(
            'Invalid time format. Try: "daily 9am", "weekly monday 3pm", "tomorrow 5pm", "every 2 hours"', 
            'INVALID_FORMAT'
        );
    }
    
    // convert 12-hour to 24-hour format
    // the meridiem handling has edge cases that bit me:
    // - 12pm = noon = hour 12 (NOT 12+12=24)
    // - 12am = midnight = hour 0 (NOT 12)
    // spent 20 minutes debugging why "12am" was scheduling for noon
    parseTime(hour, minute, meridiem) {
        let h = parseInt(hour);
        const m = parseInt(minute);
        
        if (meridiem) {
            if (meridiem.toLowerCase() === 'pm' && h !== 12) {
                h += 12;
            } else if (meridiem.toLowerCase() === 'am' && h === 12) {
                h = 0;  // midnight edge case
            }
        }
        
        return { hour: h, minute: m };
    }
    
    // calculate next occurrence of a daily schedule
    // if it's 8am and they want 9am: today at 9am
    // if it's 10am and they want 9am: tomorrow at 9am
    getNextDailyRun(time) {
        const now = new Date();
        const next = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            time.hour,
            time.minute,
            0,  // seconds
            0   // milliseconds
        );
        
        // if we already passed this time today, bump to tomorrow
        if (next.getTime() <= now.getTime()) {
            next.setDate(next.getDate() + 1);
        }
        
        return next.getTime();
    }
    
    // calculate next weekly occurrence
    // this was annoying because of the day wrapping:
    // - if today is wednesday and they want monday: next monday (5 days)
    // - if today is monday and they want monday: depends on time
    //   - if before the time: today at that time
    //   - if after the time: next monday (7 days)
    getNextWeeklyRun(dayName, time) {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDay = days.indexOf(dayName.toLowerCase());
        
        const now = new Date();
        const currentDay = now.getDay();
        
        // calculate days until target day
        let daysUntil = targetDay - currentDay;
        
        // if target day already passed this week, or it's today but time passed
        // go to next week's occurrence
        if (daysUntil < 0 || (daysUntil === 0 && now.getHours() >= time.hour)) {
            daysUntil += 7;
        }
        
        const next = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + daysUntil,
            time.hour,
            time.minute,
            0,
            0
        );
        
        return next.getTime();
    }
    
    // helper: get timestamp for today at specific time
    getTodayAt(time) {
        const now = new Date();
        const target = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            time.hour,
            time.minute,
            0,
            0
        );
        return target.getTime();
    }
    
    // helper: get timestamp for tomorrow at specific time
    getTomorrowAt(time) {
        const now = new Date();
        const target = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + 1,
            time.hour,
            time.minute,
            0,
            0
        );
        return target.getTime();
    }
}

/**
 * ScheduleManager - the core engine
 * 
 * handles storage, execution, and rescheduling. completely discord-agnostic -
 * it just takes channel IDs as strings and returns due schedules. the bot
 * layer handles actually sending to discord.
 * 
 * === Dual-Map Pattern ===
 * 
 * this.schedules: Map<id, schedule>
 *    └→ primary storage, keyed by unique id
 *    └→ O(1) lookup when checking/deleting by id
 * 
 * this.channelSchedules: Map<channelId, Set<id>>
 *    └→ index for channel-based queries
 *    └→ O(1) to get all schedules in a channel (for list command)
 *    └→ O(1) to count channel schedules (for limit enforcement)
 * 
 * why not just one Map?
 * - listing a channel's schedules would be O(n) scan of ALL schedules
 * - with the index, it's O(k) where k = schedules in that channel
 * - for a bot in 100 servers with 20 schedules each, that's 2000 schedules
 * - scanning all 2000 to find 20 is wasteful when a Set lookup is instant
 * 
 * the tradeoff is keeping them in sync - every create/delete touches both.
 * worth it for the performance gain on reads.
 * 
 * === Why Store nextRun As Timestamp? ===
 * 
 * considered storing just the time pattern and calculating on each check.
 * but that means parsing "daily 9am" and doing date math 2x per minute.
 * 
 * by storing nextRun as a precalculated timestamp:
 * - check loop is just a numeric comparison (fast)
 * - only recalculate when rescheduling after execution
 * - trades a bit of storage for way better check performance
 */
class ScheduleManager {
    constructor() {
        this.schedules = new Map();  // id → full schedule object
        this.channelSchedules = new Map();  // channelId → Set of schedule ids
        this.nextId = 1;
        this.parser = new TimeParser();  // composition over inheritance
        this.checkTimer = null;
        
        log.info('MANAGER', `Schedule Manager initialized by Keystone`);
    }
    
    // create a new scheduled message
    // validates limits, parses time, stores, persists
    async create(channelId, message, timeString, createdBy) {
        try {
            // enforce per-channel limit using the channelSchedules index
            // O(1) check thanks to Set.size
            const channelSet = this.channelSchedules.get(channelId) || new Set();
            if (channelSet.size >= config.maxSchedulesPerChannel) {
                throw new ScheduleError(
                    `Maximum schedules (${config.maxSchedulesPerChannel}) reached for this channel`,
                    'LIMIT_REACHED'
                );
            }
            
            // delegate time parsing to TimeParser
            // if it can't parse, error bubbles up with helpful message
            const timeData = this.parser.parse(timeString);
            
            // build the schedule object
            // spread timeData to get type, nextRun, interval, etc
            const schedule = {
                id: this.nextId++,
                channelId,
                message,
                createdBy,  // for ownership checks on delete
                createdAt: Date.now(),
                enabled: true,  // for future pause/resume feature
                ...timeData  // includes: type, nextRun, and type-specific fields
            };
            
            // IMPORTANT: update both maps to keep them in sync
            // forgot this once and had schedules executing but not showing in list
            this.schedules.set(schedule.id, schedule);
            channelSet.add(schedule.id);
            this.channelSchedules.set(channelId, channelSet);
            
            await this.save();
            
            log.success('MANAGER', `Created schedule #${schedule.id} for ${new Date(schedule.nextRun).toLocaleString()}`);
            
            return schedule;
            
        } catch (error) {
            log.error('MANAGER', `Failed to create schedule: ${error.message}`);
            throw error;
        }
    }
    
    // delete a schedule by id
    // includes ownership check so users can't delete each other's schedules
    async delete(scheduleId, userId) {
        const schedule = this.schedules.get(scheduleId);
        
        if (!schedule) {
            throw new ScheduleError('Schedule not found', 'NOT_FOUND');
        }
        
        // verify ownership - important in shared channels
        // admins bypassing this is a todo for later
        if (schedule.createdBy !== userId) {
            throw new ScheduleError('Not authorized to delete this schedule', 'UNAUTHORIZED');
        }
        
        // IMPORTANT: remove from both maps
        this.schedules.delete(scheduleId);
        const channelSet = this.channelSchedules.get(schedule.channelId);
        if (channelSet) {
            channelSet.delete(scheduleId);
        }
        
        await this.save();
        
        log.success('MANAGER', `Deleted schedule #${scheduleId}`);
        return schedule;
    }
    
    // list all schedules in a channel
    // uses the channelSchedules index for fast lookup
    list(channelId) {
        const channelSet = this.channelSchedules.get(channelId) || new Set();
        const schedules = [];
        
        // resolve ids to full schedule objects
        for (const scheduleId of channelSet) {
            const schedule = this.schedules.get(scheduleId);
            // only show enabled schedules (for future pause feature)
            if (schedule && schedule.enabled) {
                schedules.push(schedule);
            }
        }
        
        // sort by next run time so soonest shows first
        // more intuitive than random order
        return schedules.sort((a, b) => a.nextRun - b.nextRun);
    }
    
    // the heartbeat - scans for due schedules and executes them
    // 
    // runs every 30 seconds. for each due schedule:
    // 1. send the message
    // 2. handle based on type:
    //    - once: delete it
    //    - recurring: reschedule next occurrence
    //    - interval: reschedule based on current time
    // 
    // separated execution (sending message) from rescheduling logic because
    // they have different failure modes. if sending fails (channel deleted),
    // we still want to update the schedule state.
    async check(client) {
        const now = Date.now();
        const due = [];
        
        // scan all schedules for ones that are due
        // Map iteration is O(n) but n is bounded and this only runs every 30s
        for (const [id, schedule] of this.schedules) {
            if (schedule.enabled && schedule.nextRun <= now) {
                due.push(schedule);
            }
        }
        
        if (due.length === 0) return [];
        
        log.info('MANAGER', `Found ${due.length} due schedules`);
        
        // process each due schedule
        for (const schedule of due) {
            try {
                // fetch the discord channel
                // this can fail if channel was deleted
                const channel = await client.channels.fetch(schedule.channelId);
                
                // process message template variables before sending
                const processedMessage = this.processMessage(schedule.message);
                await channel.send(processedMessage);
                
                log.success('MANAGER', `Sent scheduled message #${schedule.id}`);
                
                // handle rescheduling based on schedule type
                // this is why having separate types is nice - clear branching logic
                if (schedule.type === 'once') {
                    // one-time schedule - delete it from both maps
                    this.schedules.delete(schedule.id);
                    const channelSet = this.channelSchedules.get(schedule.channelId);
                    if (channelSet) channelSet.delete(schedule.id);
                    
                } else if (schedule.type === 'recurring') {
                    // recurring - calculate next occurrence
                    // just add the interval to current nextRun
                    if (schedule.interval === 'daily') {
                        schedule.nextRun += 86400000;  // 24 hours in ms
                    } else if (schedule.interval === 'weekly') {
                        schedule.nextRun += 604800000;  // 7 days in ms
                    }
                    
                } else if (schedule.type === 'interval') {
                    // interval-based - reschedule from current time, not original nextRun
                    // this prevents drift accumulation if we're running late
                    schedule.nextRun = now + schedule.intervalMs;
                }
                
            } catch (error) {
                log.error('MANAGER', `Failed to send schedule #${schedule.id}: ${error.message}`);
                
                // channel might be deleted or bot kicked from server
                // should probably delete the schedule but leaving it for now
                // in case it's a temporary permission issue
            }
        }
        
        // persist the updated schedule states
        await this.save();
        return due;
    }
    
    // process template variables in message text
    // 
    // added this because people wanted dynamic content in scheduled messages
    // like "Today is {day}" or "Report for {date}"
    // 
    // kept it simple with just three variables. could add more but these
    // cover 90% of use cases. for complex templating they can use a webhook.
    processMessage(template) {
        const now = new Date();
        
        // replace template variables with current values
        // doing it at send-time instead of schedule-time so the date is accurate
        return template
            .replace('{date}', now.toLocaleDateString())
            .replace('{time}', now.toLocaleTimeString())
            .replace('{day}', now.toLocaleDateString('en-US', { weekday: 'long' }));
    }
    
    // start the polling loop
    // called once on bot ready
    startChecking(client) {
        // clear any existing timer - safety check for restart scenarios
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
        }
        
        // setInterval for continuous polling
        // wrapped in catch so one error doesn't kill the loop
        this.checkTimer = setInterval(() => {
            this.check(client).catch(err => log.error('MANAGER', `Check failed: ${err.message}`));
        }, config.checkInterval);
        
        log.info('MANAGER', `Started checking every ${config.checkInterval}ms`);
    }
    
    // persist to JSON file
    // called after every mutation (create, delete, execute)
    // 
    // JSON is simple and human-readable. considered sqlite but:
    // - JSON is easier to debug (can just cat the file)
    // - no dependencies
    // - fast enough for expected scale (hundreds of schedules, not millions)
    async save() {
        try {
            // Maps and Sets need conversion for JSON
            const data = {
                nextId: this.nextId,  // preserve id sequence across restarts
                schedules: Array.from(this.schedules.values()),
                // convert the index too so we maintain channel associations
                channelSchedules: Array.from(this.channelSchedules.entries()).map(([channelId, set]) => ({
                    channelId,
                    scheduleIds: Array.from(set)
                }))
            };
            
            // pretty print for easier debugging
            await fs.writeFile(config.dataFile, JSON.stringify(data, null, 2));
            log.info('STORAGE', `Saved ${this.schedules.size} schedules`);
            
        } catch (error) {
            log.error('STORAGE', `Failed to save: ${error.message}`);
            // not rethrowing because we don't want save failures to break the bot
            // the schedule is still in memory, we'll try saving again next time
        }
    }
    
    // load schedules from disk on startup
    // rebuilds both maps from serialized data
    async load() {
        try {
            const content = await fs.readFile(config.dataFile, 'utf8');
            const data = JSON.parse(content);
            
            // restore id counter to avoid collisions
            this.nextId = data.nextId || 1;
            
            // rebuild the primary map
            this.schedules.clear();
            for (const schedule of data.schedules || []) {
                this.schedules.set(schedule.id, schedule);
            }
            
            // rebuild the channel index
            // convert arrays back to Sets
            this.channelSchedules.clear();
            for (const { channelId, scheduleIds } of data.channelSchedules || []) {
                this.channelSchedules.set(channelId, new Set(scheduleIds));
            }
            
            log.success('STORAGE', `Loaded ${this.schedules.size} schedules`);
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                // file doesn't exist - first run
                log.info('STORAGE', 'No existing data file');
            } else {
                log.error('STORAGE', `Failed to load: ${error.message}`);
            }
        }
    }
}

/**
 * ScheduleBot - discord interface layer
 * 
 * intentionally thin. all the scheduling logic lives in ScheduleManager.
 * this class just:
 * - handles discord connection
 * - parses commands
 * - formats embeds
 * - calls manager methods
 * 
 * the manager is completely discord-agnostic. it takes strings and returns
 * data. we could plug it into a telegram bot or web dashboard without
 * changing a line of manager code.
 */
class ScheduleBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent  // required to read message text
            ]
        });
        
        this.manager = new ScheduleManager();  // composition
        this.setupEventHandlers();
        
        log.info('BOT', 'Schedule Bot initialized');
    }
    
    // wire up discord events to manager actions
    setupEventHandlers() {
        // ready event - load data and start the check loop
        this.client.on('ready', async () => {
            log.success('BOT', `Logged in as ${this.client.user.tag}`);
            
            // load any schedules from last session
            await this.manager.load();
            
            // start the polling loop
            this.manager.startChecking(this.client);
            
            // immediate check in case we have overdue schedules from downtime
            // if bot was offline for an hour, there might be missed schedules
            await this.manager.check(this.client);
        });
        
        // command handler - filter for our prefix and dispatch
        this.client.on('messageCreate', async (message) => {
            if (message.author.bot) return;  // ignore bots to prevent loops
            if (!message.content.startsWith('!schedule')) return;
            
            await this.handleCommand(message);
        });
    }
    
    // command router - parses the command and calls appropriate manager method
    async handleCommand(message) {
        const args = message.content.slice(10).trim();  // remove "!schedule "
        
        try {
            // LIST command - show all schedules in this channel
            if (args.toLowerCase() === 'list') {
                const schedules = this.manager.list(message.channel.id);
                
                // format as embed for clean display
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📅 Scheduled Messages')
                    .setDescription(
                        schedules.length === 0
                            ? 'No scheduled messages in this channel'
                            : schedules.map(s => {
                                const time = new Date(s.nextRun).toLocaleString();
                                // icon based on schedule type for visual clarity
                                const type = s.type === 'once' ? '⏰' : (s.type === 'recurring' ? '🔄' : '⏱️');
                                // truncate long messages so embed doesn't get huge
                                const msg = s.message.substring(0, 50);
                                const truncated = s.message.length > 50 ? '...' : '';
                                return `**#${s.id}** ${type} ${time}\n> ${msg}${truncated}`;
                            }).join('\n\n')
                    )
                    .setFooter({ text: `Total: ${schedules.length}/${config.maxSchedulesPerChannel}` });
                
                await message.reply({ embeds: [embed] });
                return;
            }
            
            // DELETE command - remove a schedule by id
            if (args.toLowerCase().startsWith('delete ')) {
                const id = parseInt(args.split(' ')[1]);
                
                if (isNaN(id)) {
                    await message.reply('❌ Please provide a valid schedule ID');
                    return;
                }
                
                // manager.delete handles ownership validation
                const schedule = await this.manager.delete(id, message.author.id);
                
                await message.reply(`✅ Deleted schedule #${schedule.id}`);
                return;
            }
            
            // CREATE schedule - format: !schedule <time> | <message>
            // pipe separator makes parsing unambiguous
            // tried comma first but "meet at 3pm, room 5" broke it
            const parts = args.split('|');
            if (parts.length !== 2) {
                // show help with examples
                await message.reply(
                    '❌ Format: `!schedule <time> | <message>`\n\n' +
                    'Examples:\n' +
                    '• `!schedule daily 9am | Good morning!`\n' +
                    '• `!schedule tomorrow 3pm | Meeting reminder`\n' +
                    '• `!schedule every 2 hours | Take a break!`\n' +
                    '• `!schedule weekly monday 10am | Weekly report`\n\n' +
                    'Template variables: {date}, {time}, {day}'
                );
                return;
            }
            
            const timeString = parts[0].trim();
            const messageText = parts[1].trim();
            
            // delegate to manager - parsing, storage, everything happens there
            const schedule = await this.manager.create(
                message.channel.id,
                messageText,
                timeString,
                message.author.id
            );
            
            // figure out human-readable type label
            const typeLabel = schedule.type === 'once' ? 'One-time' : 
                              schedule.type === 'recurring' ? 'Recurring' : 'Interval';
            
            // confirmation embed with all the details
            const embed = new EmbedBuilder()
                .setColor(0x57F287)  // green
                .setTitle('✅ Schedule Created')
                .addFields(
                    { name: 'Type', value: typeLabel, inline: true },
                    { name: 'Next Run', value: new Date(schedule.nextRun).toLocaleString(), inline: true },
                    { name: 'Message', value: messageText }
                )
                .setFooter({ text: `Schedule #${schedule.id}` });
            
            await message.reply({ embeds: [embed] });
            
        } catch (error) {
            log.error('COMMAND', error.message);
            
            // user-friendly error display
            await message.reply(`❌ Error: ${error.message}`);
        }
    }
    
    // connect to discord and go live
    async start() {
        await this.client.login(config.token);
    }
}

// entry point - only runs if this file is executed directly
if (require.main === module) {
    console.log(`
╔════════════════════════════════════╗
║  ScheduleBot v0.5.8                ║
║  Automated Message Scheduler       ║
║  Created by: Keystone              ║
╚════════════════════════════════════╝
    `);
    
    const bot = new ScheduleBot();
    
    bot.start().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

// export for testing or importing as a module
module.exports = { ScheduleBot, ScheduleManager, TimeParser };
