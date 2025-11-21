/**
 * RemindBot - Natural Language Reminder Bot
 * Author: Keystone
 * Created: 2025-11-21
 * Version: 0.9.7
 * 
 * A Discord bot for setting reminders using natural language.
 * Just type stuff like "remind me in 2 hours" and it works!
 * 
 * TODO: Add support for more complex time patterns
 * TODO: Maybe add DM reminders?
 */
 
// imports
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');
 
// bot config stuff
const config = {
    token: 'TOKEN </>',
    dataFile: './reminders.json',
    checkInterval: 1000, // 1 second, was 30s but that was too slow lol
    maxRemindersPerUser: 25,
    enableDebug: true,
    defaultTimezone: 'UTC',
    embedColor: 0x5865F2  // discord blurple
};
 
// quick logging utility i made
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
 
// custom error class for better error handling
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
 * This took forever to get right with all the regex patterns
 */
class TimeParser {
    constructor() {
        // all my regex patterns for different time formats
        this.patterns = {
            // matches: "in 5 minutes", "in 2 hours", etc
            relative: /^in\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d|week|w)s?$/i,
            
            // matches: "every 2 hours", "every day at 9am"
            recurring: /^every\s+(\d+)?\s*(second|minute|hour|day|week)s?(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i,
            
            // matches: "tomorrow at 3pm"
            tomorrow: /^tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
            
            // matches: "at 5:30pm"
            absolute: /^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i
        };
        
        // millisecond conversions
        this.multipliers = {
            second: 1000, sec: 1000, s: 1000,
            minute: 60000, min: 60000, m: 60000,
            hour: 3600000, hr: 3600000, h: 3600000,
            day: 86400000, d: 86400000,
            week: 604800000, w: 604800000
        };
    }
    
    // main parse function - this is where the magic happens
    parse(input) {
        const cleaned = input.trim().toLowerCase();
        
        // check if its a relative time first
        const relativeMatch = cleaned.match(this.patterns.relative);
        if (relativeMatch) {
            const [_, amount, unit] = relativeMatch;
            const ms = parseInt(amount) * this.multipliers[unit];
            const timestamp = new Date(Date.now() + ms);
            
            log.info('PARSER', `Parsed relative: +${amount}${unit} → ${timestamp.toISOString()}`);
            return { timestamp, interval: null, isRecurring: false };
        }
        
        // check for recurring pattern
        const recurringMatch = cleaned.match(this.patterns.recurring);
        if (recurringMatch) {
            const [_, amount, unit, hour, minute, meridiem] = recurringMatch;
            const interval = (parseInt(amount) || 1) * this.multipliers[unit];
            
            let timestamp = new Date();
            if (hour) {
                // user specified a specific time
                timestamp = this.calculateTimeToday(parseInt(hour), parseInt(minute) || 0, meridiem);
                // if we already passed that time today, go to next occurrence
                if (timestamp < Date.now()) {
                    timestamp = new Date(timestamp.getTime() + interval);
                }
            } else {
                // just start from now
                timestamp = new Date(Date.now() + interval);
            }
            
            log.info('PARSER', `Parsed recurring: every ${amount || 1}${unit} → first at ${timestamp.toISOString()}`);
            return { timestamp, interval, isRecurring: true };
        }
        
        // check tomorrow pattern
        const tomorrowMatch = cleaned.match(this.patterns.tomorrow);
        if (tomorrowMatch) {
            const [_, hour, minute, meridiem] = tomorrowMatch;
            const timestamp = this.calculateTimeTomorrow(parseInt(hour), parseInt(minute) || 0, meridiem);
            
            log.info('PARSER', `Parsed tomorrow: ${hour}:${minute || '00'}${meridiem || ''} → ${timestamp.toISOString()}`);
            return { timestamp, interval: null, isRecurring: false };
        }
        
        // check absolute time
        const absoluteMatch = cleaned.match(this.patterns.absolute);
        if (absoluteMatch) {
            const [_, hour, minute, meridiem] = absoluteMatch;
            let timestamp = this.calculateTimeToday(parseInt(hour), parseInt(minute) || 0, meridiem);
            
            // if the time already passed today, do it tomorrow instead
            if (timestamp < Date.now()) {
                timestamp = new Date(timestamp.getTime() + 86400000); // add 1 day
                log.info('PARSER', 'Time passed today, scheduling for tomorrow');
            }
            
            log.info('PARSER', `Parsed absolute: ${hour}:${minute || '00'}${meridiem || ''} → ${timestamp.toISOString()}`);
            return { timestamp, interval: null, isRecurring: false };
        }
        
        // couldn't parse it :(
        throw new ReminderError('Could not parse time expression', 'PARSE_FAILED');
    }
    
    // helper function to calculate a time for today
    calculateTimeToday(hour, minute, meridiem) {
        let adjustedHour = hour;
        
        // handle am/pm conversion
        if (meridiem) {
            if (meridiem.toLowerCase() === 'pm' && hour !== 12) {
                adjustedHour = hour + 12;
            } else if (meridiem.toLowerCase() === 'am' && hour === 12) {
                adjustedHour = 0; // midnight
            }
        }
        
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
    
    // same thing but for tomorrow
    calculateTimeTomorrow(hour, minute, meridiem) {
        const timestamp = this.calculateTimeToday(hour, minute, meridiem);
        return new Date(timestamp.getTime() + 86400000); // just add a day
    }
}
 
/**
 * ReminderManager - handles all reminder storage and checking
 */
class ReminderManager extends EventEmitter {
    constructor() {
        super();
        this.reminders = new Map(); // using Map for O(1) lookups
        this.userReminders = new Map(); // track reminders per user
        this.nextId = 1;
        this.checkTimer = null;
        this.parser = new TimeParser();
        
        log.info('MANAGER', `Reminder Manager initialized by Keystone`);
    }
    
    // create a new reminder
    async create(userId, channelId, message, timeString) {
        try {
            // check if user hit the limit
            const userReminderSet = this.userReminders.get(userId) || new Set();
            if (userReminderSet.size >= config.maxRemindersPerUser) {
                throw new ReminderError(
                    `Maximum reminders (${config.maxRemindersPerUser}) reached`,
                    'LIMIT_REACHED'
                );
            }
            
            // parse the time string
            const { timestamp, interval, isRecurring } = this.parser.parse(timeString);
            
            // build reminder obj
            const reminder = {
                id: this.nextId++,
                userId,
                channelId,
                message,
                timestamp: timestamp.getTime(),
                interval,
                isRecurring,
                createdAt: Date.now(),
                triggered: false
            };
            
            // save it
            this.reminders.set(reminder.id, reminder);
            userReminderSet.add(reminder.id);
            this.userReminders.set(userId, userReminderSet);
            
            // save to file
            await this.save();
            
            log.success('MANAGER', `Created reminder #${reminder.id} for ${timestamp.toISOString()}`);
            this.emit('reminder:created', reminder);
            
            return reminder;
            
        } catch (error) {
            log.error('MANAGER', `Failed to create reminder: ${error.message}`);
            throw error;
        }
    }
    
    // delete a reminder
    async delete(reminderId, userId) {
        const reminder = this.reminders.get(reminderId);
        
        if (!reminder) {
            throw new ReminderError('Reminder not found', 'NOT_FOUND');
        }
        
        // make sure the user owns this reminder
        if (reminder.userId !== userId) {
            throw new ReminderError('Not authorized to delete this reminder', 'UNAUTHORIZED');
        }
        
        // remove it
        this.reminders.delete(reminderId);
        const userSet = this.userReminders.get(userId);
        if (userSet) {
            userSet.delete(reminderId);
        }
        
        await this.save();
        
        log.success('MANAGER', `Deleted reminder #${reminderId}`);
        this.emit('reminder:deleted', reminder);
        
        return reminder;
    }
    
    // get all reminders for a user
    list(userId) {
        const userSet = this.userReminders.get(userId) || new Set();
        const userReminders = [];
        
        // collect all reminders for this user
        for (const reminderId of userSet) {
            const reminder = this.reminders.get(reminderId);
            if (reminder) {
                userReminders.push(reminder);
            }
        }
        
        // sort by time
        return userReminders.sort((a, b) => a.timestamp - b.timestamp);
    }
    
    // check for due reminders - runs every second
    async check() {
        const now = Date.now();
        const triggered = [];
        
        // find all due reminders
        for (const [id, reminder] of this.reminders) {
            if (!reminder.triggered && reminder.timestamp <= now) {
                triggered.push(reminder);
                
                // if its recurring, schedule the next one
                if (reminder.isRecurring && reminder.interval) {
                    reminder.timestamp = now + reminder.interval;
                    log.info('MANAGER', `Recurring reminder #${id} rescheduled for ${new Date(reminder.timestamp).toISOString()}`);
                } else {
                    // one-time reminder, mark as done
                    reminder.triggered = true;
                }
            }
        }
        
        // cleanup triggered one-time reminders
        for (const [id, reminder] of this.reminders) {
            if (reminder.triggered && !reminder.isRecurring) {
                const userSet = this.userReminders.get(reminder.userId);
                if (userSet) {
                    userSet.delete(id);
                }
                this.reminders.delete(id);
            }
        }
        
        // save and emit events if we triggered any
        if (triggered.length > 0) {
            await this.save();
            
            for (const reminder of triggered) {
                this.emit('reminder:trigger', reminder);
            }
        }
        
        return triggered;
    }
    
    // start the checking loop
    startChecking() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
        }
        
        // set up the interval
        this.checkTimer = setInterval(() => {
            this.check().catch(err => log.error('MANAGER', `Check failed: ${err.message}`));
        }, config.checkInterval);
        
        log.info('MANAGER', `Started checking every ${config.checkInterval}ms`);
    }
    
    // save all reminders to file
    async save() {
        try {
            const data = {
                nextId: this.nextId,
                reminders: Array.from(this.reminders.values()),
                userReminders: Array.from(this.userReminders.entries()).map(([userId, set]) => ({
                    userId,
                    reminderIds: Array.from(set)
                }))
            };
            
            // pretty print for easier debugging
            await fs.writeFile(config.dataFile, JSON.stringify(data, null, 2), 'utf8');
            log.info('STORAGE', `Saved ${this.reminders.size} reminders to disk`);
            
        } catch (error) {
            log.error('STORAGE', `Failed to save: ${error.message}`);
            throw error;
        }
    }
    
    // load reminders from file on startup
    async load() {
        try {
            const fileContent = await fs.readFile(config.dataFile, 'utf8');
            const data = JSON.parse(fileContent);
            
            this.nextId = data.nextId || 1;
            
            // restore all reminders
            this.reminders.clear();
            for (const reminder of data.reminders || []) {
                this.reminders.set(reminder.id, reminder);
            }
            
            // restore user mappings
            this.userReminders.clear();
            for (const { userId, reminderIds } of data.userReminders || []) {
                this.userReminders.set(userId, new Set(reminderIds));
            }
            
            log.success('STORAGE', `Loaded ${this.reminders.size} reminders from disk`);
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                // file doesnt exist yet, thats ok
                log.info('STORAGE', 'No existing data file, starting fresh');
            } else {
                log.error('STORAGE', `Failed to load: ${error.message}`);
            }
        }
    }
}
 
/**
 * Main bot class
 */
class ReminderBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });
        
        this.manager = new ReminderManager();
        this.setupEventHandlers();
        
        log.info('BOT', 'Reminder Bot initialized');
    }
    
    // setup all the discord event handlers
    setupEventHandlers() {
        // bot is ready
        this.client.on('ready', async () => {
            log.success('BOT', `Logged in as ${this.client.user.tag}`);
            
            // load saved reminders
            await this.manager.load();
            
            // start the checker
            this.manager.startChecking();
            
            // check right away in case we have overdue stuff
            await this.manager.check();
        });
        
        // handle messages
        this.client.on('messageCreate', async (message) => {
            // ignore bots
            if (message.author.bot) return;
            
            // only care about !remind commands
            if (!message.content.startsWith('!remind')) return;
            
            await this.handleCommand(message);
        });
        
        // when a reminder triggers
        this.manager.on('reminder:trigger', async (reminder) => {
            await this.sendReminder(reminder);
        });
        
        // log errors
        this.client.on('error', (error) => {
            log.error('BOT', `Discord error: ${error.message}`);
        });
    }
    
    // handle !remind commands
    async handleCommand(message) {
        const args = message.content.slice(8).trim(); // remove "!remind "
        
        try {
            // list command
            if (args.toLowerCase() === 'list') {
                const reminders = this.manager.list(message.author.id);
                
                const embed = new EmbedBuilder()
                    .setColor(config.embedColor)
                    .setTitle('📋 Your Reminders')
                    .setDescription(
                        reminders.length === 0
                            ? 'You have no active reminders'
                            : reminders.map(r => {
                                const time = new Date(r.timestamp).toLocaleString();
                                const recurring = r.isRecurring ? ' 🔄' : '';
                                return `**#${r.id}**${recurring} - ${time}\n> ${r.message}`;
                            }).join('\n\n')
                    )
                    .setFooter({ text: `Total: ${reminders.length}/${config.maxRemindersPerUser}` });
                
                await message.reply({ embeds: [embed] });
                return;
            }
            
            // delete command
            if (args.toLowerCase().startsWith('delete ')) {
                const id = parseInt(args.split(' ')[1]);
                
                if (isNaN(id)) {
                    await message.reply('❌ Please provide a valid reminder ID');
                    return;
                }
                
                const reminder = await this.manager.delete(id, message.author.id);
                
                const embed = new EmbedBuilder()
                    .setColor(0xED4245) // red
                    .setTitle('🗑️ Reminder Deleted')
                    .setDescription(`Deleted reminder #${reminder.id}:\n> ${reminder.message}`);
                
                await message.reply({ embeds: [embed] });
                return;
            }
            
            // create reminder - format: !remind <time> | <message>
            const parts = args.split('|');
            if (parts.length !== 2) {
                await message.reply('❌ Format: `!remind <time> | <message>`\nExample: `!remind in 1 hour | Check the oven`');
                return;
            }
            
            const timeString = parts[0].trim();
            const reminderMessage = parts[1].trim();
            
            const reminder = await this.manager.create(
                message.author.id,
                message.channel.id,
                reminderMessage,
                timeString
            );
            
            // build success embed
            const embed = new EmbedBuilder()
                .setColor(0x57F287) // green
                .setTitle('✅ Reminder Set')
                .addFields(
                    { name: 'When', value: new Date(reminder.timestamp).toLocaleString(), inline: true },
                    { name: 'Type', value: reminder.isRecurring ? '🔄 Recurring' : '⏰ One-time', inline: true },
                    { name: 'Message', value: reminderMessage }
                )
                .setFooter({ text: `Reminder #${reminder.id}` });
            
            await message.reply({ embeds: [embed] });
            
        } catch (error) {
            log.error('COMMAND', error.message);
            
            // error embed
            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('❌ Error')
                .setDescription(error.message)
                .setFooter({ text: 'Try: !remind in 30 minutes | Your message' });
            
            await message.reply({ embeds: [embed] });
        }
    }
    
    // send a reminder to the channel
    async sendReminder(reminder) {
        try {
            const channel = await this.client.channels.fetch(reminder.channelId);
            
            const embed = new EmbedBuilder()
                .setColor(0xFEE75C) // yellow
                .setTitle('⏰ Reminder!')
                .setDescription(reminder.message)
                .setTimestamp(reminder.createdAt)
                .setFooter({ text: `Reminder #${reminder.id}` });
            
            // ping the user
            await channel.send({
                content: `<@${reminder.userId}>`,
                embeds: [embed]
            });
            
            log.success('REMINDER', `Sent reminder #${reminder.id} to user ${reminder.userId}`);
            
        } catch (error) {
            log.error('REMINDER', `Failed to send reminder #${reminder.id}: ${error.message}`);
            // maybe the channel was deleted or something
        }
    }
    
    // start the bot
    async start() {
        try {
            await this.client.login(config.token);
        } catch (error) {
            log.error('BOT', `Failed to login: ${error.message}`);
            throw error;
        }
    }
}
 
// startup
if (require.main === module) {
    console.log(`
╔════════════════════════════════════╗
║  RemindBot v0.9.7                  ║
║  Natural Language Reminder Bot     ║
║  Created by: KeyStone              ║
╚════════════════════════════════════╝
    `);
    
    const bot = new ReminderBot();
    
    // start it up!
    bot.start().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
 
// export for testing or whatever
module.exports = { ReminderBot, ReminderManager, TimeParser };
