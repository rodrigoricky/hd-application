/**
 * ScheduleBot - Automated Message Scheduler
 * Author: Keystone
 * Created: 2025-11-21
 * Version: 0.5.8
 * 
 * Discord bot for scheduling messages. supports recurring msgs and stuff
 * Good for announcements, daily reminders, etc
 */

// imports
const { Client, GatewayIntentBits, EmbedBuilder, ChannelType } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');

// config
const config = {
    token: 'token </>',
    dataFile: './schedules.json',
    checkInterval: 30000,  // 30 sec check interval
    maxSchedulesPerChannel: 20,
    enableDebug: true,
    timezone: 'America/New_York'  // default tz
};

// basic logging
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

// custom error class
class ScheduleError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ScheduleError';
        this.code = code;
        this.timestamp = new Date();
    }
}

/**
 * TimeParser - handles all the time parsing stuff
 * This was annoying to write tbh
 */
class TimeParser {
    // parse time strings into schedule data
    parse(input) {
        const cleaned = input.trim().toLowerCase();
        
        // check for daily recurring first - "daily 9am" or "daily at 3:30pm"
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
        
        // one-time schedules - "tomorrow 3pm", etc
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
        
        // today schedule
        const todayMatch = cleaned.match(/^today\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (todayMatch) {
            const [_, hour, minute, meridiem] = todayMatch;
            const time = this.parseTime(hour, minute || '0', meridiem);
            let nextRun = this.getTodayAt(time);
            
            // if time already passed, do tomorrow instead
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
        const intervalMatch = cleaned.match(/^every\s+(\d+)\s+(hour|hours|minute|minutes)$/i);
        if (intervalMatch) {
            const [_, amount, unit] = intervalMatch;
            // convert to ms
            const ms = unit.startsWith('hour') 
                ? parseInt(amount) * 3600000  // hours to ms
                : parseInt(amount) * 60000;    // minutes to ms
            
            return {
                type: 'interval',
                intervalMs: ms,
                nextRun: Date.now() + ms
            };
        }
        
        // couldn't parse it
        throw new ScheduleError('Invalid time format. Try: "daily 9am", "weekly monday 3pm", "tomorrow 5pm", "every 2 hours"', 'INVALID_FORMAT');
    }
    
    // convert to 24hr format
    parseTime(hour, minute, meridiem) {
        let h = parseInt(hour);
        const m = parseInt(minute);
        
        if (meridiem) {
            if (meridiem.toLowerCase() === 'pm' && h !== 12) {
                h += 12;
            } else if (meridiem.toLowerCase() === 'am' && h === 12) {
                h = 0;  // midnight
            }
        }
        
        return { hour: h, minute: m };
    }
    
    // get next daily run time
    getNextDailyRun(time) {
        const now = new Date();
        const next = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            time.hour,
            time.minute,
            0,
            0
        );
        
        // if we already passed this time today, go to tomorrow
        if (next.getTime() <= now.getTime()) {
            next.setDate(next.getDate() + 1);
        }
        
        return next.getTime();
    }
    
    // calculate next weekly run
    getNextWeeklyRun(dayName, time) {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDay = days.indexOf(dayName.toLowerCase());
        
        const now = new Date();
        const currentDay = now.getDay();
        
        let daysUntil = targetDay - currentDay;
        // if day passed or its today but time passed
        if (daysUntil < 0 || (daysUntil === 0 && now.getHours() >= time.hour)) {
            daysUntil += 7;  // next week
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
    
    // helper for today at specific time
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
    
    // helper for tomorrow at specific time
    getTomorrowAt(time) {
        const now = new Date();
        const target = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + 1,  // tomorrow
            time.hour,
            time.minute,
            0,
            0
        );
        return target.getTime();
    }
}

/**
 * Main schedule manager
 * Handles all the schedule storage and checking
 */
class ScheduleManager {
    constructor() {
        this.schedules = new Map();  // id -> schedule
        this.channelSchedules = new Map();  // channelId -> set of ids
        this.nextId = 1;
        this.parser = new TimeParser();
        this.checkTimer = null;
        
        log.info('MANAGER', `Schedule Manager initialized by Keystone`);
    }
    
    // create new scheduled msg
    async create(channelId, message, timeString, createdBy) {
        try {
            // check limits
            const channelSet = this.channelSchedules.get(channelId) || new Set();
            if (channelSet.size >= config.maxSchedulesPerChannel) {
                throw new ScheduleError(
                    `Maximum schedules (${config.maxSchedulesPerChannel}) reached for this channel`,
                    'LIMIT_REACHED'
                );
            }
            
            // parse the time string
            const timeData = this.parser.parse(timeString);
            
            // build schedule object
            const schedule = {
                id: this.nextId++,
                channelId,
                message,
                createdBy,
                createdAt: Date.now(),
                enabled: true,
                ...timeData  // spread the time data
            };
            
            // save it
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
    
    // delete a schedule
    async delete(scheduleId, userId) {
        const schedule = this.schedules.get(scheduleId);
        
        if (!schedule) {
            throw new ScheduleError('Schedule not found', 'NOT_FOUND');
        }
        
        // check if user owns this schedule
        if (schedule.createdBy !== userId) {
            throw new ScheduleError('Not authorized to delete this schedule', 'UNAUTHORIZED');
        }
        
        // remove it
        this.schedules.delete(scheduleId);
        
        const channelSet = this.channelSchedules.get(schedule.channelId);
        if (channelSet) {
            channelSet.delete(scheduleId);
        }
        
        await this.save();
        
        log.success('MANAGER', `Deleted schedule #${scheduleId}`);
        return schedule;
    }
    
    // list schedules for a channel
    list(channelId) {
        const channelSet = this.channelSchedules.get(channelId) || new Set();
        const schedules = [];
        
        for (const scheduleId of channelSet) {
            const schedule = this.schedules.get(scheduleId);
            if (schedule && schedule.enabled) {
                schedules.push(schedule);
            }
        }
        
        // sort by next run time
        return schedules.sort((a, b) => a.nextRun - b.nextRun);
    }
    
    // check for due schedules
    async check(client) {
        const now = Date.now();
        const due = [];
        
        // find all due schedules
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
                const channel = await client.channels.fetch(schedule.channelId);
                
                // send the message
                await channel.send(this.processMessage(schedule.message));
                
                log.success('MANAGER', `Sent scheduled message #${schedule.id}`);
                
                // handle different schedule types
                if (schedule.type === 'once') {
                    // one-time, delete it
                    this.schedules.delete(schedule.id);
                    const channelSet = this.channelSchedules.get(schedule.channelId);
                    if (channelSet) channelSet.delete(schedule.id);
                    
                } else if (schedule.type === 'recurring') {
                    // recurring, calculate next time
                    if (schedule.interval === 'daily') {
                        schedule.nextRun += 86400000;  // add 24 hrs
                    } else if (schedule.interval === 'weekly') {
                        schedule.nextRun += 604800000;  // add 7 days
                    }
                    
                } else if (schedule.type === 'interval') {
                    // interval based
                    schedule.nextRun = now + schedule.intervalMs;
                }
                
            } catch (error) {
                log.error('MANAGER', `Failed to send schedule #${schedule.id}: ${error.message}`);
                // maybe channel was deleted or something
            }
        }
        
        await this.save();
        return due;
    }
    
    // process message variables
    processMessage(template) {
        const now = new Date();
        
        // replace template vars
        return template
            .replace('{date}', now.toLocaleDateString())
            .replace('{time}', now.toLocaleTimeString())
            .replace('{day}', now.toLocaleDateString('en-US', { weekday: 'long' }));
    }
    
    // start the checking loop
    startChecking(client) {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
        }
        
        this.checkTimer = setInterval(() => {
            this.check(client).catch(err => log.error('MANAGER', `Check failed: ${err.message}`));
        }, config.checkInterval);
        
        log.info('MANAGER', `Started checking every ${config.checkInterval}ms`);
    }
    
    // save to file
    async save() {
        try {
            const data = {
                nextId: this.nextId,
                schedules: Array.from(this.schedules.values()),
                channelSchedules: Array.from(this.channelSchedules.entries()).map(([channelId, set]) => ({
                    channelId,
                    scheduleIds: Array.from(set)
                }))
            };
            
            await fs.writeFile(config.dataFile, JSON.stringify(data, null, 2));
            log.info('STORAGE', `Saved ${this.schedules.size} schedules`);
            
        } catch (error) {
            log.error('STORAGE', `Failed to save: ${error.message}`);
        }
    }
    
    // load from file
    async load() {
        try {
            const content = await fs.readFile(config.dataFile, 'utf8');
            const data = JSON.parse(content);
            
            this.nextId = data.nextId || 1;
            
            // restore schedules
            this.schedules.clear();
            for (const schedule of data.schedules || []) {
                this.schedules.set(schedule.id, schedule);
            }
            
            // restore channel mappings
            this.channelSchedules.clear();
            for (const { channelId, scheduleIds } of data.channelSchedules || []) {
                this.channelSchedules.set(channelId, new Set(scheduleIds));
            }
            
            log.success('STORAGE', `Loaded ${this.schedules.size} schedules`);
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                log.info('STORAGE', 'No existing data file');  // first run
            } else {
                log.error('STORAGE', `Failed to load: ${error.message}`);
            }
        }
    }
}

// main bot class
class ScheduleBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });
        
        this.manager = new ScheduleManager();
        this.setupEventHandlers();
        
        log.info('BOT', 'Schedule Bot initialized');
    }
    
    setupEventHandlers() {
        // bot ready
        this.client.on('ready', async () => {
            log.success('BOT', `Logged in as ${this.client.user.tag}`);
            
            // load saved schedules
            await this.manager.load();
            this.manager.startChecking(this.client);
            
            // check right away for overdue stuff
            await this.manager.check(this.client);
        });
        
        // handle commands
        this.client.on('messageCreate', async (message) => {
            if (message.author.bot) return;  // ignore bots
            if (!message.content.startsWith('!schedule')) return;
            
            await this.handleCommand(message);
        });
    }
    
    async handleCommand(message) {
        const args = message.content.slice(10).trim();  // remove "!schedule "
        
        try {
            // list command
            if (args.toLowerCase() === 'list') {
                const schedules = this.manager.list(message.channel.id);
                
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('📅 Scheduled Messages')
                    .setDescription(
                        schedules.length === 0
                            ? 'No scheduled messages in this channel'
                            : schedules.map(s => {
                                const time = new Date(s.nextRun).toLocaleString();
                                const type = s.type === 'once' ? '⏰' : (s.type === 'recurring' ? '🔄' : '⏱️');
                                // truncate long messages
                                return `**#${s.id}** ${type} ${time}\n> ${s.message.substring(0, 50)}${s.message.length > 50 ? '...' : ''}`;
                            }).join('\n\n')
                    )
                    .setFooter({ text: `Total: ${schedules.length}/${config.maxSchedulesPerChannel}` });
                
                await message.reply({ embeds: [embed] });
                return;
            }
            
            // delete command
            if (args.toLowerCase().startsWith('delete ')) {
                const id = parseInt(args.split(' ')[1]);
                
                if (isNaN(id)) {
                    await message.reply('❌ Please provide a valid schedule ID');
                    return;
                }
                
                const schedule = await this.manager.delete(id, message.author.id);
                
                await message.reply(`✅ Deleted schedule #${schedule.id}`);
                return;
            }
            
            // create schedule - format: !schedule <time> | <message>
            const parts = args.split('|');
            if (parts.length !== 2) {
                // show help
                await message.reply('❌ Format: `!schedule <time> | <message>`\n\nExamples:\n• `!schedule daily 9am | Good morning!`\n• `!schedule tomorrow 3pm | Meeting reminder`\n• `!schedule every 2 hours | Take a break!`');
                return;
            }
            
            const timeString = parts[0].trim();
            const messageText = parts[1].trim();
            
            const schedule = await this.manager.create(
                message.channel.id,
                messageText,
                timeString,
                message.author.id
            );
            
            // figure out type label
            const typeLabel = schedule.type === 'once' ? 'One-time' : 
                              schedule.type === 'recurring' ? 'Recurring' : 'Interval';
            
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
            
            await message.reply(`❌ Error: ${error.message}`);
        }
    }
    
    async start() {
        await this.client.login(config.token);
    }
}

// startup
if (require.main === module) {
    console.log(`
╔════════════════════════════════════╗
║  ScheduleBot v0.5.8                ║
║  Automated Message Scheduler       ║
║  Created by: Keystone              ║
╚════════════════════════════════════╝
    `);
    
    const bot = new ScheduleBot();
    
    // start the bot
    bot.start().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

// export for testing or whatever
module.exports = { ScheduleBot, ScheduleManager, TimeParser };
