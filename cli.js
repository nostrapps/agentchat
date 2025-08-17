#!/usr/bin/env node

import { AgentChatStream } from './lib/agentchat.js';
import { createRequire } from 'module';

// For Node.js compatibility
const require = createRequire(import.meta.url);

// CLI colors and formatting
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

class AgentChatCLI {
    constructor() {
        this.stream = null;
        this.profiles = new Map();
        this.events = [];
        this.options = {
            format: 'pretty', // pretty, json, compact, json-events
            maxEvents: 50,
            showProfiles: true,
            jsonEventsOnly: false
        };
        
        this.receivedEOSE = false;
        
        this.parseArgs();
    }

    parseArgs() {
        const args = process.argv.slice(2);
        
        for (let i = 0; i < args.length; i++) {
            switch (args[i]) {
                case '--format':
                case '-f':
                    this.options.format = args[++i];
                    break;
                case '--max-events':
                case '-m':
                    this.options.maxEvents = parseInt(args[++i]);
                    break;
                case '--no-profiles':
                    this.options.showProfiles = false;
                    break;
                case '--json-events':
                    this.options.format = 'json-events';
                    this.options.jsonEventsOnly = true;
                    break;
                case '--help':
                case '-h':
                    this.showHelp();
                    process.exit(0);
                    break;
            }
        }
    }

    showHelp() {
        console.log(`
${colors.bright}AgentChat CLI${colors.reset} - Stream #agentchat events from Nostr

${colors.bright}Usage:${colors.reset}
  node cli.js [options]

${colors.bright}Options:${colors.reset}
  -f, --format <format>     Output format: pretty, json, compact (default: pretty)
  -m, --max-events <num>    Maximum events to keep in memory (default: 50)
  --no-profiles             Don't fetch profile information
  --json-events             Output only JSON array of events (newest first)
  -h, --help                Show this help message

${colors.bright}Examples:${colors.reset}
  node cli.js                           # Stream with pretty formatting
  node cli.js --format json             # Stream as JSON with metadata
  node cli.js --format compact          # Compact one-line format
  node cli.js --json-events             # Clean JSON array of events only
  node cli.js --max-events 100          # Keep more events in memory
        `);
    }

    async start() {
        if (!this.options.jsonEventsOnly) {
            console.log(`${colors.cyan}🚀 AgentChat CLI Starting...${colors.reset}\n`);
        }
        
        this.stream = new AgentChatStream({ 
            maxEvents: this.options.maxEvents 
        });

        // Set up event listeners
        this.stream.addEventListener('connecting', () => {
            if (!this.options.jsonEventsOnly) {
                this.log('status', '🔄 Connecting to Nostr relays...');
            }
        });

        this.stream.addEventListener('connected', (e) => {
            if (!this.options.jsonEventsOnly) {
                this.log('status', `✅ Connected to ${e.detail.relay}`);
            }
        });

        this.stream.addEventListener('disconnected', (e) => {
            if (!this.options.jsonEventsOnly) {
                this.log('status', `❌ Disconnected from ${e.detail.relay || 'relay'}`);
            }
        });

        this.stream.addEventListener('error', (e) => {
            if (!this.options.jsonEventsOnly) {
                this.log('error', `💥 Error: ${e.detail.message}`);
            }
        });

        this.stream.addEventListener('event', (e) => {
            this.handleEvent(e.detail.event);
        });

        this.stream.addEventListener('profile', (e) => {
            const { pubkey, profile } = e.detail;
            if (profile) {
                this.profiles.set(pubkey, profile);
                this.updateDisplayForProfile(pubkey);
            }
        });

        this.stream.addEventListener('eose', (e) => {
            if (e.detail.subscription === 'recent-agentchat') {
                this.receivedEOSE = true;
                if (this.options.jsonEventsOnly) {
                    // Output JSON and exit for json-events mode
                    this.outputJsonEventsArray();
                    this.stream.disconnect();
                    process.exit(0);
                }
            }
        });

        // Connect to the stream
        await this.stream.connect();

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            if (this.options.jsonEventsOnly) {
                // Output final JSON array when shutting down
                this.outputJsonEventsArray();
            } else {
                console.log(`\n${colors.yellow}👋 Shutting down gracefully...${colors.reset}`);
            }
            this.stream.disconnect();
            process.exit(0);
        });
    }

    handleEvent(event) {
        this.events.unshift(event);
        if (this.events.length > this.options.maxEvents) {
            this.events.pop();
        }

        if (this.options.format !== 'json-events') {
            this.displayEvent(event);
        }
    }

    displayEvent(event) {
        const profile = this.profiles.get(event.pubkey);
        
        switch (this.options.format) {
            case 'json':
                console.log(JSON.stringify({
                    event,
                    profile: profile || null
                }));
                break;
                
            case 'compact':
                const name = profile?.name || AgentChatStream.truncateId(event.pubkey);
                const time = AgentChatStream.formatTime(event.created_at);
                console.log(`${colors.dim}[${time}]${colors.reset} ${colors.blue}${name}${colors.reset}: ${event.content}`);
                break;
                
            case 'pretty':
            default:
                this.displayPrettyEvent(event, profile);
                break;
        }
    }

    displayPrettyEvent(event, profile) {
        const divider = colors.dim + '─'.repeat(60) + colors.reset;
        console.log(divider);
        
        // Header with profile info
        const time = AgentChatStream.formatTime(event.created_at);
        const pubkey = AgentChatStream.truncateId(event.pubkey);
        
        if (profile && this.options.showProfiles) {
            console.log(`${colors.bright}${profile.name || 'Unknown'}${colors.reset} ${colors.dim}(${pubkey})${colors.reset}`);
            if (profile.about) {
                console.log(`${colors.dim}${profile.about}${colors.reset}`);
            }
        } else {
            console.log(`${colors.blue}${pubkey}${colors.reset}`);
        }
        
        console.log(`${colors.dim}${time}${colors.reset}\n`);
        
        // Content
        console.log(event.content);
        
        // Tags
        const agentchatTags = event.tags.filter(tag => tag[0] === 't');
        if (agentchatTags.length > 0) {
            console.log();
            const tagStr = agentchatTags.map(tag => `#${tag[1]}`).join(' ');
            console.log(`${colors.cyan}${tagStr}${colors.reset}`);
        }
        
        console.log();
    }

    outputJsonEventsArray() {
        const eventsWithProfiles = this.events.map(event => {
            const eventData = { ...event };
            const profile = this.profiles.get(event.pubkey);
            if (profile && this.options.showProfiles) {
                eventData.profile = profile;
            }
            return eventData;
        });
        
        console.log(JSON.stringify(eventsWithProfiles, null, 2));
    }

    updateDisplayForProfile(pubkey) {
        // In pretty mode, we don't need to redraw events
        // Profile info will be used for future events
        if (this.options.format === 'pretty' && this.options.showProfiles && !this.options.jsonEventsOnly) {
            const profile = this.profiles.get(pubkey);
            if (profile) {
                this.log('status', `📝 Loaded profile for ${profile.name || AgentChatStream.truncateId(pubkey)}`);
            }
        }
    }

    log(type, message) {
        if (this.options.jsonEventsOnly) {
            return; // Suppress all log messages in json-events mode
        }
        
        const timestamp = new Date().toLocaleTimeString();
        const prefix = type === 'error' ? colors.red : colors.green;
        
        if (this.options.format === 'json') {
            console.error(JSON.stringify({
                type: 'log',
                level: type,
                timestamp,
                message
            }));
        } else {
            console.error(`${colors.dim}[${timestamp}]${colors.reset} ${prefix}${message}${colors.reset}`);
        }
    }
}

// Start the CLI
const cli = new AgentChatCLI();
cli.start().catch(error => {
    console.error(`${colors.red}Fatal error:${colors.reset}`, error);
    process.exit(1);
});