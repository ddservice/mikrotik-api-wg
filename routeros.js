const net = require('net');
const crypto = require('crypto');

class RouterOSClient {
    constructor(host, port = 8728, username, password) {
        this.host = host;
        this.port = parseInt(port) || 8728;
        this.username = username;
        this.password = password;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.queue = [];
        this.busy = false;
        this.connected = false;
        this.connectPromise = null;
    }

    connect() {
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = new Promise((resolve, reject) => {
            if (!this.host || !this.username) {
                return reject(new Error('Missing Router connection details (Host or Username)'));
            }

            this.socket = new net.Socket();
            this.socket.setTimeout(10000); // 10s timeout

            this.socket.on('connect', async () => {
                this.connected = true;
                try {
                    await this.login();
                    resolve(this);
                } catch (err) {
                    this.close();
                    reject(err);
                }
            });

            this.socket.on('data', (chunk) => {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                this.parseData();
            });

            this.socket.on('error', (err) => {
                this.handleSocketError(err);
                if (!this.connected) reject(err);
            });

            this.socket.on('timeout', () => {
                const err = new Error('Connection timeout to MikroTik Router');
                this.handleSocketError(err);
                if (!this.connected) reject(err);
            });

            this.socket.on('close', () => {
                this.connected = false;
                this.handleSocketError(new Error('Socket connection closed'));
            });

            this.socket.connect(this.port, this.host);
        });

        return this.connectPromise;
    }

    handleSocketError(err) {
        // Reject current running commands in queue
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            item.reject(err);
        }
        this.busy = false;
    }

    close() {
        this.connected = false;
        this.connectPromise = null;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.buffer = Buffer.alloc(0);
    }

    async login() {
        try {
            // Step 1: Try modern login (v6.43+) where username and password are sent directly
            const response = await this.exec('/login', {
                name: this.username,
                password: this.password
            });
            // If success, we are done
            return;
        } catch (err) {
            // If modern login fails, check if we need to attempt legacy challenge-response
            // Legacy routers return a challenge in the first response to a blank `/login`
            try {
                const initRes = await this.exec('/login');
                // The router should return !done with a ret parameter (challenge)
                // Let's see if the first element contains the challenge
                const doneSentence = initRes[0];
                if (doneSentence && doneSentence.ret) {
                    const challengeHex = doneSentence.ret;
                    const challengeBuf = Buffer.from(challengeHex, 'hex');
                    const passwordBuf = Buffer.from(this.password, 'utf8');
                    const zeroBuf = Buffer.from([0]);

                    const md5sum = crypto.createHash('md5');
                    md5sum.update(zeroBuf);
                    md5sum.update(passwordBuf);
                    md5sum.update(challengeBuf);
                    const responseHex = md5sum.digest('hex');

                    await this.exec('/login', {
                        name: this.username,
                        response: '00' + responseHex
                    });
                    return;
                }
            } catch (legacyErr) {
                throw new Error(`MikroTik authentication failed: ${err.message || err}`);
            }
            throw err;
        }
    }

    exec(command, args = {}) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                return reject(new Error('Not connected to router'));
            }

            // Convert arguments object or array to API words format
            const words = [command];
            if (Array.isArray(args)) {
                words.push(...args);
            } else if (typeof args === 'object') {
                for (const [key, val] of Object.entries(args)) {
                    if (val !== undefined && val !== null) {
                        words.push(`=${key}=${val}`);
                    }
                }
            }

            this.queue.push({
                words,
                resolve,
                reject,
                results: []
            });

            this.processQueue();
        });
    }

    processQueue() {
        if (this.busy || this.queue.length === 0) return;
        this.busy = true;

        const item = this.queue[0];
        
        // Write the words
        const bufferList = [];
        for (const word of item.words) {
            const wordBuf = Buffer.from(word, 'utf8');
            const lenBuf = this.encodeLength(wordBuf.length);
            bufferList.push(lenBuf, wordBuf);
        }
        bufferList.push(Buffer.from([0])); // End of sentence (zero word)

        this.socket.write(Buffer.concat(bufferList));
    }

    encodeLength(len) {
        if (len < 0x80) {
            return Buffer.from([len]);
        } else if (len < 0x4000) {
            return Buffer.from([
                (len >> 8) | 0x80,
                len & 0xFF
            ]);
        } else if (len < 0x200000) {
            return Buffer.from([
                (len >> 16) | 0xC0,
                (len >> 8) & 0xFF,
                len & 0xFF
            ]);
        } else if (len < 0x10000000) {
            return Buffer.from([
                (len >> 24) | 0xE0,
                (len >> 16) & 0xFF,
                (len >> 8) & 0xFF,
                len & 0xFF
            ]);
        } else {
            return Buffer.from([
                0xF0,
                (len >> 24) & 0xFF,
                (len >> 16) & 0xFF,
                (len >> 8) & 0xFF,
                len & 0xFF
            ]);
        }
    }

    parseData() {
        let offset = 0;
        let sentences = [];
        let currentSentence = [];

        while (offset < this.buffer.length) {
            let first = this.buffer[offset];
            let len = 0;
            let bytesRead = 0;

            if ((first & 0x80) === 0x00) {
                len = first;
                bytesRead = 1;
            } else if ((first & 0xC0) === 0x80) {
                if (offset + 1 >= this.buffer.length) break;
                len = ((first & 0x3F) << 8) | this.buffer[offset + 1];
                bytesRead = 2;
            } else if ((first & 0xE0) === 0xC0) {
                if (offset + 2 >= this.buffer.length) break;
                len = ((first & 0x1F) << 16) | (this.buffer[offset + 1] << 8) | this.buffer[offset + 2];
                bytesRead = 3;
            } else if ((first & 0xF0) === 0xE0) {
                if (offset + 3 >= this.buffer.length) break;
                len = ((first & 0x0F) << 24) | (this.buffer[offset + 1] << 16) | (this.buffer[offset + 2] << 8) | this.buffer[offset + 3];
                bytesRead = 4;
            } else if ((first & 0xF8) === 0xF0) {
                if (offset + 4 >= this.buffer.length) break;
                len = (this.buffer[offset + 1] << 24) | (this.buffer[offset + 2] << 16) | (this.buffer[offset + 3] << 8) | this.buffer[offset + 4];
                bytesRead = 5;
            }

            if (offset + bytesRead + len > this.buffer.length) {
                // Word not fully received yet
                break;
            }

            const word = this.buffer.toString('utf8', offset + bytesRead, offset + bytesRead + len);
            offset += bytesRead + len;

            if (len === 0) {
                // End of sentence
                sentences.push(currentSentence);
                currentSentence = [];
            } else {
                currentSentence.push(word);
            }
        }

        // Slice the processed data from buffer
        if (offset > 0) {
            this.buffer = this.buffer.slice(offset);
        }

        // Process completed sentences
        for (const sentence of sentences) {
            this.handleSentence(sentence);
        }
    }

    handleSentence(words) {
        if (words.length === 0) return;
        const type = words[0]; // !re, !done, !trap, !fatal

        // Parse attributes
        const attributes = {};
        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            if (word.startsWith('=')) {
                // format: =name=value or =name (empty value)
                const secondEqIndex = word.indexOf('=', 1);
                if (secondEqIndex !== -1) {
                    const key = word.substring(1, secondEqIndex);
                    const val = word.substring(secondEqIndex + 1);
                    attributes[key] = val;
                } else {
                    const key = word.substring(1);
                    attributes[key] = '';
                }
            } else if (word.startsWith('.')) {
                // format: .tag=value
                const eqIndex = word.indexOf('=');
                if (eqIndex !== -1) {
                    const key = word.substring(0, eqIndex);
                    const val = word.substring(eqIndex + 1);
                    attributes[key] = val;
                }
            }
        }

        const item = this.queue[0];
        if (!item) return;

        if (type === '!re') {
            item.results.push(attributes);
        } else if (type === '!done') {
            // done may contain a return value (like challenge)
            if (Object.keys(attributes).length > 0) {
                item.results.push(attributes);
            }
            const res = item.results;
            this.queue.shift();
            this.busy = false;
            item.resolve(res);
            this.processQueue();
        } else if (type === '!trap') {
            const msg = attributes.message || 'Unknown RouterOS error';
            this.queue.shift();
            this.busy = false;
            item.reject(new Error(msg));
            this.processQueue();
        } else if (type === '!fatal') {
            const msg = words[1] || 'Fatal RouterOS error';
            this.close();
            item.reject(new Error(msg));
        }
    }
}

module.exports = RouterOSClient;
