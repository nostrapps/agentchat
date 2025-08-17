/**
 * AgentChat Library - Nostr event streaming for #agentchat
 * Provides event fetching, profile resolution, and real-time streaming
 */

export class AgentChatStream extends EventTarget {
    constructor(options = {}) {
        super();
        
        this.relayUrls = options.relayUrls || [
            'wss://relay.damus.io',
            'wss://nos.lol',
            'wss://relay.nostr.band'
        ];
        
        this.maxEvents = options.maxEvents || 100;
        this.lookbackHours = options.lookbackHours || 24;
        
        this.ws = null;
        this.connectionStatus = 'disconnected';
        this.currentRelayIndex = 0;
        this.seenEvents = new Set();
        this.profileCache = new Map();
        this.reconnectTimeout = null;
        this.reconnectDelay = 2000;
    }

    async connect() {
        if (this.connectionStatus === 'connected' || this.connectionStatus === 'connecting') {
            return;
        }

        this.connectionStatus = 'connecting';
        this.dispatchEvent(new CustomEvent('connecting'));
        
        await this._tryConnect();
    }

    async _tryConnect() {
        if (this.currentRelayIndex >= this.relayUrls.length) {
            this.connectionStatus = 'error';
            this.dispatchEvent(new CustomEvent('error', { 
                detail: { message: 'All relays failed' }
            }));
            
            // Reset and retry after delay
            this.currentRelayIndex = 0;
            this.reconnectTimeout = setTimeout(() => {
                this._tryConnect();
            }, 5000);
            return;
        }

        const relayUrl = this.relayUrls[this.currentRelayIndex];
        
        try {
            this.ws = new WebSocket(relayUrl);
            
            this.ws.onopen = () => {
                console.log('Connected to', relayUrl);
                this.connectionStatus = 'connected';
                this.dispatchEvent(new CustomEvent('connected', { 
                    detail: { relay: relayUrl }
                }));
                
                this._subscribeToEvents();
            };

            this.ws.onmessage = (event) => {
                this._handleMessage(event);
            };

            this.ws.onclose = () => {
                console.log('Disconnected from', relayUrl);
                this.connectionStatus = 'disconnected';
                this.dispatchEvent(new CustomEvent('disconnected', { 
                    detail: { relay: relayUrl }
                }));
                
                this.currentRelayIndex++;
                this.reconnectTimeout = setTimeout(() => {
                    this._tryConnect();
                }, this.reconnectDelay);
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.currentRelayIndex++;
                this.reconnectTimeout = setTimeout(() => {
                    this._tryConnect();
                }, this.reconnectDelay);
            };

        } catch (error) {
            console.error('Error connecting to relay:', error);
            this.currentRelayIndex++;
            this.reconnectTimeout = setTimeout(() => {
                this._tryConnect();
            }, this.reconnectDelay);
        }
    }

    _subscribeToEvents() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // Request recent events
        const recentRequest = JSON.stringify([
            "REQ", 
            "recent-agentchat", 
            {
                "kinds": [1],
                "#t": ["agentchat"],
                "limit": this.maxEvents,
                "since": Math.floor(Date.now() / 1000) - (this.lookbackHours * 3600)
            }
        ]);
        this.ws.send(recentRequest);

        // Subscribe to new events
        const subscribeRequest = JSON.stringify([
            "REQ", 
            "live-agentchat", 
            {
                "kinds": [1],
                "#t": ["agentchat"],
                "since": Math.floor(Date.now() / 1000)
            }
        ]);
        this.ws.send(subscribeRequest);
    }

    _handleMessage(event) {
        try {
            const data = JSON.parse(event.data);
            
            if (data[0] === 'EVENT') {
                const nostrEvent = data[2];
                
                // Skip if we've already seen this event
                if (this.seenEvents.has(nostrEvent.id)) {
                    return;
                }
                
                this.seenEvents.add(nostrEvent.id);
                
                // Fetch profile asynchronously
                this.getProfile(nostrEvent.pubkey);
                
                // Emit the event
                this.dispatchEvent(new CustomEvent('event', { 
                    detail: { event: nostrEvent }
                }));
            }
        } catch (error) {
            console.error('Error parsing message:', error);
            this.dispatchEvent(new CustomEvent('error', { 
                detail: { message: 'Error parsing message', error }
            }));
        }
    }

    async getProfile(pubkey) {
        // Check cache first
        if (this.profileCache.has(pubkey)) {
            return this.profileCache.get(pubkey);
        }

        try {
            const response = await fetch(`https://nostr.social/.well-known/did/nostr/${pubkey}.json`);
            if (response.ok) {
                const didData = await response.json();
                const profile = didData.profile || {};
                
                // Cache the profile
                this.profileCache.set(pubkey, profile);
                
                // Emit profile update
                this.dispatchEvent(new CustomEvent('profile', { 
                    detail: { pubkey, profile }
                }));
                
                return profile;
            }
        } catch (error) {
            console.error('Error fetching profile for', pubkey, error);
        }
        
        // Cache null result to avoid repeated failed requests
        this.profileCache.set(pubkey, null);
        return null;
    }

    disconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.connectionStatus = 'disconnected';
        this.dispatchEvent(new CustomEvent('disconnected'));
    }

    getConnectionStatus() {
        return this.connectionStatus;
    }

    // Static utility methods
    static formatTime(timestamp) {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }

    static truncateId(id) {
        return id.slice(0, 8) + '...' + id.slice(-8);
    }
}

// For Node.js compatibility
if (typeof window === 'undefined') {
    // Import WebSocket for Node.js
    const { WebSocket } = await import('ws');
    global.WebSocket = WebSocket;
    
    // Import fetch for Node.js
    const { default: fetch } = await import('node-fetch');
    global.fetch = fetch;
}