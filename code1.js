/**
 * RemindBot - Natural Language Reminder Bot
 * Author: Keystone
 * Created: 2025-11-21
 * Version: 0.9.7
 * 
 * A Discord bot for setting reminders using natural language.
 * Just type stuff like "remind me in 2 hours" and it works!
 * 
 * === Architecture Overview ===
 * 
 * i went through a few iterations before landing on this structure.
 * originally everything was in one big file with functions calling each other
 * directly - got messy fast when i tried adding recurring reminders.
 * 
 * ended up with three layers that each do one thing:
 * 
 * TimeParser (parsing layer)
 *    └→ just converts human time strings to timestamps, nothing else
 *    └→ made this its own class after the parse logic hit 100+ lines
 *    └→ could swap this for a real NLP library later without touching anything else
 * 
 * ReminderManager (core layer) 
 *    └→ this is where i burned most of my time. handles storage, timing, everything
 *    └→ extends EventEmitter - this was a late change. originally it called bot methods
 *       directly but that meant i couldn't test the manager without discord.js running.
 *       now it just fires events and doesn't care who's listening
 *    └→ uses two Maps that mirror each other - more on this below, it's important
 * 
 * ReminderBot (interface layer)
 *    └→ thin wrapper around discord.js. parses commands, formats responses
 *    └→ subscribes to manager events and translates them to discord actions
 *    └→ if i wanted telegram support, i'd write TelegramBot with same pattern
 * 
 * the data flow goes like this:
 *    user types "!remind in 2 hours | do laundry"
 *    → ReminderBot.handleCommand() splits it up
 *    → ReminderManager.create() validates limits
 *    → TimeParser.parse() figures out the timestamp
 *    → saved to both Maps + written to disk
 *    → check() loop runs every second looking for due reminders
 *    → when one's due, manager emits 'reminder:trigger'
 *    → ReminderBot catches that, sends discord message with ping
 * 
 * the event-driven thing was annoying to set up but worth it. i can run
 * the manager in a test file with a fake listener and verify the timing
 * logic works without ever connecting to discord. saved me a ton of time.
 * 
 * TODO: Add support for more complex time patterns
 * TODO: Maybe add DM reminders?
 */
 
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');
 
// bot config stuff
// moved these out of the code after changing checkInterval like 10 times during testing
const config = {
    token: 'TOKEN </>',
    dataFile: './reminders.json',
    // started at 30 seconds, but reminders felt laggy. 1 second feels instant
    // and the cpu usage is basically nothing since we're just iterating a Map
    checkInterval: 1000,
    // had to add this after someone set 500 reminders and the list command timed out
    maxRemindersPerUser: 25,
    enableDebug: true,
    defaultTimezone: 'UTC',
    embedColor: 0x5865F2  // discord blurple
};
 
// quick logging utility i made
// got tired of writing console.log everywhere with different formats
// the component tag helps when debugging - can grep for [PARSER] or [MANAGER]
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
 
// custom error class - added this after realizing i needed to tell apart
// "couldn't parse your time" from "you hit the reminder limit" from "reminder not found"
// the code field lets handleCommand show different error messages for each case
// timestamp is mostly for logging/debugging when something goes wrong
class ReminderError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ReminderError';
        this.code = code;
        this.timestamp = new Date();
        Error.captureStackTrace(this, this.constructor);
    }
}
 
/**
 * TimeParser - handles all the natural language parsing
 * 
 * this started as a few regex patterns in the create() function.
 * pulled it out when i realized i wanted to support "tomorrow at 3pm"
 * and "every 2 hours" - the parsing logic was drowning the actual
 * reminder logic.
 * 
 * making it a separate class means:
 * - i can test parsing without creating actual reminders
 * - the manager doesn't need to know how "in 5 minutes" becomes a timestamp
 * - if someone wants to use chrono-node or something fancier, swap it here
 * 
 * it's stateless on purpose - just takes a string, returns a timestamp.
 * no side effects, no dependencies on the rest of the system.
 * makes it really easy to reason about.
 */
class TimeParser {
    constructor() {
        // these patterns took forever to get right. lots of trial and error
        // with regex101.com until they matched what i wanted without false positives
        //
        // order matters when parsing - we try most specific patterns first
        // so "every 2 hours at 3pm" doesn't accidentally match the simpler "every 2 hours"
        this.patterns = {
            // matches: "in 5 minutes", "in 2 hours", "in 1 day", etc
            // this is like 80% of what people actually type so it's first
            // the 's?' at the end handles both "minute" and "minutes"
            relative: /^in\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d|week|w)s?$/i,
            
            // matches: "every 2 hours", "every day at 9am"
            // the amount is optional - "every hour" defaults to 1
            // struggled with this one because of the optional "at X" part
            recurring: /^every\s+(\d+)?\s*(second|minute|hour|day|week)s?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i,
            
            // matches: "tomorrow at 3pm"
            // simpler than i expected once i had the time parsing helper
            tomorrow: /^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
            
            // matches: "at 5:30pm", "at 14:00"
            // handles both 12-hour and 24-hour formats
            absolute: /^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i
        };
        
        // lookup table for converting units to milliseconds
        // multiple aliases because people type differently - "5m", "5min", "5 minutes" all work
        // learned the hard way that users will type things every possible way
        this.multipliers = {
            second: 1000, sec: 1000, s: 1000,
            minute: 60000, min: 60000, m: 60000,
            hour: 3600000, hr: 3600000, h: 3600000,
            day: 86400000, d: 86400000,
            week: 604800000, w: 604800000
        };
    }
    
    // main entry point - takes a time string, returns timestamp + metadata
    // throws ReminderError if nothing matches so the caller can show a helpful message
    // 
    // returns an object instead of just a timestamp because recurring reminders
    // need the interval for rescheduling. learned this when i added recurring
    // and had to refactor the return type
    parse(input) {
        const cleaned = input.trim().toLowerCase();
        
        // relative time is the most common case - "in 5 minutes"
        // simple math: current time + (amount * milliseconds per unit)
        const relativeMatch = cleaned.match(this.patterns.relative);
        if (relativeMatch) {
            const [_, amount, unit] = relativeMatch;
            const ms = parseInt(amount) * this.multipliers[unit];
            const timestamp = new Date(Date.now() + ms);
            
            log.info('PARSER', `Parsed relative: +${amount}${unit} → ${timestamp.toISOString()}`);
            // interval is null because this isn't recurring
            // isRecurring flag tells the manager how to handle it when triggered
            return { timestamp, interval: null, isRecurring: false };
        }
        
        // recurring pattern - "every 2 hours" or "every day at 9am"
        // this was the trickiest to implement because there are two cases:
        // 1. just an interval (every 2 hours) - first trigger is now + interval
        // 2. interval with specific time (every day at 9am) - first trigger is at that time
        const recurringMatch = cleaned.match(this.patterns.recurring);
        if (recurringMatch) {
            const [_, amount, unit, hour, minute, meridiem] = recurringMatch;
            // default to 1 if no amount - "every hour" means every 1 hour
            const interval = (parseInt(amount) || 1) * this.multipliers[unit];
            
            let timestamp = new Date();
            if (hour) {
                // user wants it at a specific time each day
                timestamp = this.calculateTimeToday(parseInt(hour), parseInt(minute) || 0, meridiem);
                // edge case that bit me: if it's 10am and they say "every day at 9am"
                // we need to start tomorrow, not schedule one in the past
                if (timestamp < Date.now()) {
                    timestamp = new Date(timestamp.getTime() + interval);
                }
            } else {
                // no specific time, just start from now
                timestamp = new Date(Date.now() + interval);
            }
            
            log.info('PARSER', `Parsed recurring: every ${amount || 1}${unit} → first at ${timestamp.toISOString()}`);
            // interval gets stored so check() can reschedule after each trigger
            return { timestamp, interval, isRecurring: true };
        }
        
        // tomorrow pattern - pretty straightforward once i had calculateTimeTomorrow
        const tomorrowMatch = cleaned.match(this.patterns.tomorrow);
        if (tomorrowMatch) {
            const [_, hour, minute, meridiem] = tomorrowMatch;
            const timestamp = this.calculateTimeTomorrow(parseInt(hour), parseInt(minute) || 0, meridiem);
            
            log.info('PARSER', `Parsed tomorrow: ${hour}:${minute || '00'}${meridiem || ''} → ${timestamp.toISOString()}`);
            return { timestamp, interval: null, isRecurring: false };
        }
        
        // absolute time - "at 5pm"
        // originally this would fail if the time already passed today
        // but users found that confusing. now it auto-rolls to tomorrow
        const absoluteMatch = cleaned.match(this.patterns.absolute);
        if (absoluteMatch) {
            const [_, hour, minute, meridiem] = absoluteMatch;
            let timestamp = this.calculateTimeToday(parseInt(hour), parseInt(minute) || 0, meridiem);
            
            // this check was added after users complained about "at 5pm" failing at 6pm
            // makes more sense to assume they meant tomorrow than to throw an error
            if (timestamp < Date.now()) {
                timestamp = new Date(timestamp.getTime() + 86400000);
                log.info('PARSER', 'Time passed today, scheduling for tomorrow');
            }
            
            log.info('PARSER', `Parsed absolute: ${hour}:${minute || '00'}${meridiem || ''} → ${timestamp.toISOString()}`);
            return { timestamp, interval: null, isRecurring: false };
        }
        
        // nothing matched - let the caller handle showing an error
        throw new ReminderError('Could not parse time expression', 'PARSE_FAILED');
    }
    
    // helper to build a Date for a specific time today
    // handles the annoying am/pm to 24-hour conversion
    calculateTimeToday(hour, minute, meridiem) {
        let adjustedHour = hour;
        
        // 12-hour to 24-hour conversion
        // the 12am/12pm edge cases tripped me up at first
        // 12pm = noon = 12:00, 12am = midnight = 00:00
        if (meridiem) {
            if (meridiem.toLowerCase() === 'pm' && hour !== 12) {
                adjustedHour = hour + 12;
            } else if (meridiem.toLowerCase() === 'am' && hour === 12) {
                adjustedHour = 0;
            }
        }
        
        // build a date for today at the specified time
        // zeroing out seconds and ms so comparisons are clean
        const now = new Date();
        const target = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            adjustedHour,
            minute,
            0,
            0
        );
        
        return target;
    }
    
    // same as above but adds a day
    // could have inlined this but it makes the calling code cleaner
    calculateTimeTomorrow(hour, minute, meridiem) {
        const timestamp = this.calculateTimeToday(hour, minute, meridiem);
        return new Date(timestamp.getTime() + 86400000);
    }
}
 
/**
 * ReminderManager - the brain of the whole operation
 * 
 * this class went through the most revisions. started as a simple array
 * of reminders with setInterval checking them. that worked until i had
 * to add user-specific limits and listing.
 * 
 * === why EventEmitter? ===
 * 
 * originally the check() function directly called bot.sendReminder().
 * seemed fine until i tried to write tests. couldn't test the timing
 * logic without a real discord connection because check() was coupled
 * to the bot.
 * 
 * with EventEmitter, check() just emits 'reminder:trigger' and doesn't
 * care who's listening. in production it's ReminderBot. in tests it's
 * a mock that counts how many times it was called.
 * 
 * also means i could add a web dashboard later that listens to the same
 * events - the manager doesn't need to know about it.
 * 
 * === why two Maps? ===
 * 
 * this.reminders: Map<id, reminder>
 *    - primary storage, keyed by reminder id
 *    - O(1) lookup when a reminder triggers and we need its details
 *    - O(1) delete when user removes a reminder by id
 * 
 * this.userReminders: Map<userId, Set<id>>
 *    - secondary index, tracks which reminders belong to which user
 *    - O(1) to get all of a user's reminders (for !remind list)
 *    - O(1) to count a user's reminders (for limit enforcement)
 * 
 * i tried using just one Map at first. listing a user's reminders meant
 * scanning every single reminder to filter by userId. that's O(n) and
 * felt slow with lots of reminders. the second Map is basically an index
 * like in a database.
 * 
 * the tradeoff is i have to keep them in sync - every create/delete
 * touches both. forgot this once and had a bug where reminders would
 * trigger but not show up in the list. now there's a comment every
 * time i modify one reminding me to modify the other.
 */
class ReminderManager extends EventEmitter {
    constructor() {
        // need to call super() because we're extending EventEmitter
        // this gives us .emit() and .on() methods
        super();
        
        // primary storage - all reminders keyed by id
        // using Map instead of object for guaranteed iteration order
        // and because .size is O(1) vs Object.keys().length
        this.reminders = new Map();
        
        // user index - for fast user-specific queries
        // Set inside because a user can't have duplicate reminder ids
        this.userReminders = new Map();
        
        // incrementing id - gets saved/loaded so we don't reuse ids after restart
        // reusing ids would be confusing if someone deleted #5 then a new one got #5
        this.nextId = 1;
        
        // reference to the setInterval so we can clear it if needed
        this.checkTimer = null;
        
        // composition: manager HAS a parser, doesn't extend it
        // the manager doesn't need to know how parsing works internally
        this.parser = new TimeParser();
        
        log.info('MANAGER', `Reminder Manager initialized by Keystone`);
    }
    
    // create a new reminder - the main entry point from the bot
    // validates limits, parses time, stores in both maps, saves to disk
    // returns the reminder object so the bot can show a confirmation
    async create(userId, channelId, message, timeString) {
        try {
            // check user's limit before doing any work
            // using the userReminders index makes this O(1)
            // originally i counted by filtering this.reminders - way slower
            const userReminderSet = this.userReminders.get(userId) || new Set();
            if (userReminderSet.size >= config.maxRemindersPerUser) {
                throw new ReminderError(
                    `Maximum reminders (${config.maxRemindersPerUser}) reached`,
                    'LIMIT_REACHED'
                );
            }
            
            // delegate parsing to TimeParser
            // if it can't parse, it throws and we catch below
            const { timestamp, interval, isRecurring } = this.parser.parse(timeString);
            
            // build the reminder object with everything we need later
            // storing channelId so we know where to send the notification
            // storing timestamp as epoch ms for easy comparison in check()
            const reminder = {
                id: this.nextId++,
                userId,
                channelId,
                message,
                timestamp: timestamp.getTime(),
                interval,  // null for one-time, ms value for recurring
                isRecurring,
                createdAt: Date.now(),
                triggered: false  // used to mark one-time reminders as done
            };
            
            // IMPORTANT: update both maps to keep them in sync
            // i've been bitten by forgetting one of these before
            this.reminders.set(reminder.id, reminder);
            userReminderSet.add(reminder.id);
            this.userReminders.set(userId, userReminderSet);
            
            // persist immediately so we don't lose reminders on crash
            // considered batching saves but the complexity wasn't worth it
            await this.save();
            
            log.success('MANAGER', `Created reminder #${reminder.id} for ${timestamp.toISOString()}`);
            
            // emit for any listeners - not used currently but could enable
            // features like "you have 3 reminders set" notifications
            this.emit('reminder:created', reminder);
            
            return reminder;
            
        } catch (error) {
            log.error('MANAGER', `Failed to create reminder: ${error.message}`);
            throw error;  // re-throw so the bot can show an error message
        }
    }
    
    // delete a reminder by id
    // validates that the user owns it first - don't want people deleting each other's
    async delete(reminderId, userId) {
        const reminder = this.reminders.get(reminderId);
        
        // can't delete what doesn't exist
        if (!reminder) {
            throw new ReminderError('Reminder not found', 'NOT_FOUND');
        }
        
        // ownership check - added this after realizing anyone could delete anyone's reminders
        // in a shared server that would be a problem
        if (reminder.userId !== userId) {
            throw new ReminderError('Not authorized to delete this reminder', 'UNAUTHORIZED');
        }
        
        // IMPORTANT: remove from both maps - same sync issue as create
        this.reminders.delete(reminderId);
        const userSet = this.userReminders.get(userId);
        if (userSet) {
            userSet.delete(reminderId);
        }
        
        await this.save();
        
        log.success('MANAGER', `Deleted reminder #${reminderId}`);
        this.emit('reminder:deleted', reminder);
        
        return reminder;  // return it so the bot can show what was deleted
    }
    
    // get all reminders for a user
    // this is why the userReminders index exists - O(1) to get the set of ids
    // then we just resolve each id to its full reminder object
    list(userId) {
        const userSet = this.userReminders.get(userId) || new Set();
        const userReminders = [];
        
        // resolve ids to full reminder objects
        for (const reminderId of userSet) {
            const reminder = this.reminders.get(reminderId);
            if (reminder) {
                userReminders.push(reminder);
            }
        }
        
        // sort by timestamp so soonest reminders show first
        // more intuitive than showing them in creation order
        return userReminders.sort((a, b) => a.timestamp - b.timestamp);
    }
    
    // the core loop - runs every second checking for due reminders
    // 
    // this is where the event architecture pays off. this method:
    // 1. finds due reminders
    // 2. handles recurring vs one-time logic
    // 3. emits events
    // 
    // it does NOT send discord messages. that's the bot's job.
    // this separation means i can test check() with a mock listener.
    async check() {
        const now = Date.now();
        const triggered = [];
        
        // iterate all reminders looking for due ones
        // Map iteration is O(n) but n is bounded by maxRemindersPerUser * users
        // in practice this is fast enough even with thousands of reminders
        for (const [id, reminder] of this.reminders) {
            // skip already-triggered one-time reminders (they get cleaned up below)
            // check timestamp against current time
            if (!reminder.triggered && reminder.timestamp <= now) {
                triggered.push(reminder);
                
                // here's where recurring and one-time diverge
                if (reminder.isRecurring && reminder.interval) {
                    // recurring: schedule the next occurrence
                    // just add the interval to current time, not the original timestamp
                    // this prevents drift if we were slow to trigger
                    reminder.timestamp = now + reminder.interval;
                    log.info('MANAGER', `Recurring reminder #${id} rescheduled for ${new Date(reminder.timestamp).toISOString()}`);
                } else {
                    // one-time: mark as triggered for cleanup
                    // can't delete here because we're iterating the map
                    // learned this the hard way - "Map modified during iteration" errors
                    reminder.triggered = true;
                }
            }
        }
        
        // second pass: cleanup triggered one-time reminders
        // doing this in a separate loop because you can't delete from a Map while iterating it
        // well, you can in JS but it's weird and i don't trust it
        for (const [id, reminder] of this.reminders) {
            if (reminder.triggered && !reminder.isRecurring) {
                // IMPORTANT: remove from both maps
                const userSet = this.userReminders.get(reminder.userId);
                if (userSet) {
                    userSet.delete(id);
                }
                this.reminders.delete(id);
            }
        }
        
        // only save if something changed - avoid unnecessary disk writes
        // disk I/O is slow and we're running this every second
        if (triggered.length > 0) {
            await this.save();
            
            // emit an event for each triggered reminder
            // ReminderBot listens to these and sends discord messages
            // the manager has no idea what happens after emit() - that's the point
            for (const reminder of triggered) {
                this.emit('reminder:trigger', reminder);
            }
        }
        
        return triggered;  // useful for testing
    }
    
    // start the polling loop
    // called once when the bot connects to discord
    startChecking() {
        // clear any existing timer - safety check for restart scenarios
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
        }
        
        // setInterval runs check() every second
        // wrapped in a function that catches errors so one failure doesn't stop the loop
        this.checkTimer = setInterval(() => {
            this.check().catch(err => log.error('MANAGER', `Check failed: ${err.message}`));
        }, config.checkInterval);
        
        log.info('MANAGER', `Started checking every ${config.checkInterval}ms`);
    }
    
    // persist everything to disk
    // called after every mutation (create, delete, trigger)
    // 
    // JSON is simple and human-readable. considered sqlite but this is
    // plenty fast for the expected scale and easier to debug
    async save() {
        try {
            // have to convert Maps and Sets to arrays for JSON
            // JSON.stringify just ignores them otherwise - found that out the hard way
            const data = {
                nextId: this.nextId,  // preserve id sequence across restarts
                reminders: Array.from(this.reminders.values()),
                // need to serialize the user index too
                userReminders: Array.from(this.userReminders.entries()).map(([userId, set]) => ({
                    userId,
                    reminderIds: Array.from(set)
                }))
            };
            
            // pretty print with indent=2 so i can actually read the file when debugging
            await fs.writeFile(config.dataFile, JSON.stringify(data, null, 2), 'utf8');
            log.info('STORAGE', `Saved ${this.reminders.size} reminders to disk`);
            
        } catch (error) {
            log.error('STORAGE', `Failed to save: ${error.message}`);
            throw error;
        }
    }
    
    // load saved reminders on startup
    // reconstructs both Maps from the JSON file
    async load() {
        try {
            const fileContent = await fs.readFile(config.dataFile, 'utf8');
            const data = JSON.parse(fileContent);
            
            // restore the id counter so we don't reuse ids
            this.nextId = data.nextId || 1;
            
            // rebuild the primary Map
            this.reminders.clear();
            for (const reminder of data.reminders || []) {
                this.reminders.set(reminder.id, reminder);
            }
            
            // rebuild the user index
            // convert arrays back to Sets
            this.userReminders.clear();
            for (const { userId, reminderIds } of data.userReminders || []) {
                this.userReminders.set(userId, new Set(reminderIds));
            }
            
            log.success('STORAGE', `Loaded ${this.reminders.size} reminders from disk`);
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                // file doesn't exist - first run, that's fine
                log.info('STORAGE', 'No existing data file, starting fresh');
            } else {
                log.error('STORAGE', `Failed to load: ${error.message}`);
            }
        }
    }
}
 
/**
 * ReminderBot - the discord interface
 * 
 * i kept this class deliberately simple. it's basically a translator:
 * - discord messages come in → it calls manager methods
 * - manager events come out → it sends discord messages
 * 
 * all the actual logic (parsing, storage, timing) lives in the manager.
 * this class just deals with discord.js stuff: embeds, replies, pings.
 * 
 * the key connection is in setupEventHandlers():
 *    this.manager.on('reminder:trigger', async (reminder) => {...})
 * 
 * when the manager's check() loop finds a due reminder, it emits an event.
 * this bot catches that event and sends a discord message. the manager
 * has no idea it's even connected to discord - it just fires events.
 * 
 * could write a TelegramBot or SlackBot with the same pattern.
 * plug it into the manager's events and it would just work.
 */
class ReminderBot {
    constructor() {
        // discord.js client with the intents we need
        // MessageContent is required to read message content after discord's changes
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });
        
        // composition: bot HAS a manager
        this.manager = new ReminderManager();
        
        // wire up all the event handlers
        this.setupEventHandlers();
        
        log.info('BOT', 'Reminder Bot initialized');
    }
    
    // connect discord events to manager methods and vice versa
    // this is the glue between the discord layer and the core logic
    setupEventHandlers() {
        // when discord connection is ready
        this.client.on('ready', async () => {
            log.success('BOT', `Logged in as ${this.client.user.tag}`);
            
            // load any reminders saved from last run
            await this.manager.load();
            
            // start the check loop
            this.manager.startChecking();
            
            // run an immediate check in case we missed any while offline
            // if the bot was down for an hour, there might be overdue reminders
            await this.manager.check();
        });
        
        // incoming messages - filter for our command and handle it
        this.client.on('messageCreate', async (message) => {
            // ignore other bots to prevent loops
            if (message.author.bot) return;
            
            // only respond to our command prefix
            if (!message.content.startsWith('!remind')) return;
            
            await this.handleCommand(message);
        });
        
        // HERE'S THE KEY CONNECTION
        // manager emits 'reminder:trigger' → we catch it and send a discord message
        // this is the output side of the event bridge
        // the manager doesn't know about discord at all, it just fires events
        this.manager.on('reminder:trigger', async (reminder) => {
            await this.sendReminder(reminder);
        });
        
        // log discord errors so they don't fail silently
        this.client.on('error', (error) => {
            log.error('BOT', `Discord error: ${error.message}`);
        });
    }
    
    // parse a !remind command and route to the right action
    // handles list, delete, and create
    async handleCommand(message) {
        const args = message.content.slice(8).trim(); // remove "!remind "
        
        try {
            // LIST command - show all reminders for this user
            if (args.toLowerCase() === 'list') {
                const reminders = this.manager.list(message.author.id);
                
                // format as a discord embed for clean presentation
                const embed = new EmbedBuilder()
                    .setColor(config.embedColor)
                    .setTitle('📋 Your Reminders')
                    .setDescription(
                        reminders.length === 0
                            ? 'You have no active reminders'
                            : reminders.map(r => {
                                const time = new Date(r.timestamp).toLocaleString();
                                // show a little icon for recurring ones
                                const recurring = r.isRecurring ? ' 🔄' : '';
                                return `**#${r.id}**${recurring} - ${time}\n> ${r.message}`;
                            }).join('\n\n')
                    )
                    .setFooter({ text: `Total: ${reminders.length}/${config.maxRemindersPerUser}` });
                
                await message.reply({ embeds: [embed] });
                return;
            }
            
            // DELETE command - remove a reminder by id
            if (args.toLowerCase().startsWith('delete ')) {
                const id = parseInt(args.split(' ')[1]);
                
                if (isNaN(id)) {
                    await message.reply('❌ Please provide a valid reminder ID');
                    return;
                }
                
                // manager.delete handles ownership check and throws if unauthorized
                const reminder = await this.manager.delete(id, message.author.id);
                
                const embed = new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('🗑️ Reminder Deleted')
                    .setDescription(`Deleted reminder #${reminder.id}:\n> ${reminder.message}`);
                
                await message.reply({ embeds: [embed] });
                return;
            }
            
            // CREATE - format is: !remind <time> | <message>
            // using pipe as separator because it's unlikely to appear in natural text
            // tried comma first but "remind me at 3pm, do laundry" broke it
            const parts = args.split('|');
            if (parts.length !== 2) {
                await message.reply('❌ Format: `!remind <time> | <message>`\nExample: `!remind in 1 hour | Check the oven`');
                return;
            }
            
            const timeString = parts[0].trim();
            const reminderMessage = parts[1].trim();
            
            // manager.create handles parsing, storage, everything
            const reminder = await this.manager.create(
                message.author.id,
                message.channel.id,  // store so we know where to send the reminder
                reminderMessage,
                timeString
            );
            
            // success embed with all the details
            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('✅ Reminder Set')
                .addFields(
                    { name: 'When', value: new Date(reminder.timestamp).toLocaleString(), inline: true },
                    { name: 'Type', value: reminder.isRecurring ? '🔄 Recurring' : '⏰ One-time', inline: true },
                    { name: 'Message', value: reminderMessage }
                )
                .setFooter({ text: `Reminder #${reminder.id}` });
            
            await message.reply({ embeds: [embed] });
            
        } catch (error) {
            // something went wrong - show a friendly error
            log.error('COMMAND', error.message);
            
            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('❌ Error')
                .setDescription(error.message)
                .setFooter({ text: 'Try: !remind in 30 minutes | Your message' });
            
            await message.reply({ embeds: [embed] });
        }
    }
    
    // send a reminder notification to discord
    // called when manager emits 'reminder:trigger'
    async sendReminder(reminder) {
        try {
            // fetch the channel using the id we stored when the reminder was created
            // this could fail if the channel was deleted
            const channel = await this.client.channels.fetch(reminder.channelId);
            
            const embed = new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle('⏰ Reminder!')
                .setDescription(reminder.message)
                .setTimestamp(reminder.createdAt)
                .setFooter({ text: `Reminder #${reminder.id}` });
            
            // ping the user so they get a notification
            // the embed alone wouldn't notify them
            await channel.send({
                content: `<@${reminder.userId}>`,
                embeds: [embed]
            });
            
            log.success('REMINDER', `Sent reminder #${reminder.id} to user ${reminder.userId}`);
            
        } catch (error) {
            // channel might be deleted, bot might be kicked, etc
            // not much we can do, just log it
            log.error('REMINDER', `Failed to send reminder #${reminder.id}: ${error.message}`);
        }
    }
    
    // connect to discord and go live
    async start() {
        try {
            await this.client.login(config.token);
        } catch (error) {
            log.error('BOT', `Failed to login: ${error.message}`);
            throw error;
        }
    }
}
 
// only run if this file is the entry point
// require.main === module is false when this file is imported by something else (like tests)
if (require.main === module) {
    console.log(`
╔════════════════════════════════════╗
║  RemindBot v0.9.7                  ║
║  Natural Language Reminder Bot     ║
║  Created by: KeyStone              ║
╚════════════════════════════════════╝
    `);
    
    const bot = new ReminderBot();
    
    bot.start().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
 
// export for testing or using as a module
module.exports = { ReminderBot, ReminderManager, TimeParser };
