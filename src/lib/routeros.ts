import net from 'net';
import crypto from 'crypto';

export class RouterOSClient {
  private host: string;
  private port: number;
  private username: string;
  private password?: string;
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private queue: Array<{
    words: string[];
    resolve: (res: any[]) => void;
    reject: (err: Error) => void;
    results: any[];
  }> = [];
  private busy: boolean = false;
  private connected: boolean = false;
  private connectPromise: Promise<RouterOSClient> | null = null;

  constructor(host: string, port: number = 8728, username: string, password?: string) {
    this.host = host;
    this.port = Number(port) || 8728;
    this.username = username;
    this.password = password || '';
  }

  connect(): Promise<RouterOSClient> {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      if (!this.host || !this.username) {
        return reject(new Error('Missing Router connection details (Host or Username)'));
      }

      this.socket = new net.Socket();
      this.socket.setTimeout(10000);

      this.socket.on('connect', async () => {
        this.connected = true;
        try {
          await this.login();
          resolve(this);
        } catch (err: any) {
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

  private handleSocketError(err: Error) {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) item.reject(err);
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

  private async login(): Promise<void> {
    try {
      await this.exec('/login', {
        name: this.username,
        password: this.password
      });
      return;
    } catch (err: any) {
      try {
        const initRes = await this.exec('/login');
        const doneSentence = initRes[0];
        if (doneSentence && doneSentence.ret) {
          const challengeHex = doneSentence.ret;
          const challengeBuf = Buffer.from(challengeHex, 'hex');
          const passwordBuf = Buffer.from(this.password || '', 'utf8');
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
      } catch (legacyErr: any) {
        throw new Error(`MikroTik authentication failed: ${err.message || err}`);
      }
      throw err;
    }
  }

  exec(command: string, args: Record<string, any> | string[] = {}): Promise<any[]> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        return reject(new Error('Not connected to router'));
      }

      const words: string[] = [command];
      if (Array.isArray(args)) {
        words.push(...args);
      } else if (typeof args === 'object' && args !== null) {
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

  private processQueue() {
    if (this.busy || this.queue.length === 0 || !this.socket) return;
    this.busy = true;

    const item = this.queue[0];
    const bufferList: Buffer[] = [];

    for (const word of item.words) {
      const wordBuf = Buffer.from(word, 'utf8');
      const lenBuf = this.encodeLength(wordBuf.length);
      bufferList.push(lenBuf, wordBuf);
    }
    bufferList.push(Buffer.from([0]));

    this.socket.write(Buffer.concat(bufferList));
  }

  private encodeLength(len: number): Buffer {
    if (len < 0x80) {
      return Buffer.from([len]);
    } else if (len < 0x4000) {
      return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
    } else if (len < 0x200000) {
      return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
    } else if (len < 0x10000000) {
      return Buffer.from([(len >> 24) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
    } else {
      return Buffer.from([0xf0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
    }
  }

  private parseData() {
    let offset = 0;
    const sentences: string[][] = [];
    let currentSentence: string[] = [];

    while (offset < this.buffer.length) {
      const first = this.buffer[offset];
      let len = 0;
      let bytesRead = 0;

      if ((first & 0x80) === 0x00) {
        len = first;
        bytesRead = 1;
      } else if ((first & 0xc0) === 0x80) {
        if (offset + 1 >= this.buffer.length) break;
        len = ((first & 0x3f) << 8) | this.buffer[offset + 1];
        bytesRead = 2;
      } else if ((first & 0xe0) === 0xc0) {
        if (offset + 2 >= this.buffer.length) break;
        len = ((first & 0x1f) << 16) | (this.buffer[offset + 1] << 8) | this.buffer[offset + 2];
        bytesRead = 3;
      } else if ((first & 0xf0) === 0xe0) {
        if (offset + 3 >= this.buffer.length) break;
        len = ((first & 0x0f) << 24) | (this.buffer[offset + 1] << 16) | (this.buffer[offset + 2] << 8) | this.buffer[offset + 3];
        bytesRead = 4;
      } else if ((first & 0xf8) === 0xf0) {
        if (offset + 4 >= this.buffer.length) break;
        len = (this.buffer[offset + 1] << 24) | (this.buffer[offset + 2] << 16) | (this.buffer[offset + 3] << 8) | this.buffer[offset + 4];
        bytesRead = 5;
      }

      if (offset + bytesRead + len > this.buffer.length) {
        break;
      }

      const word = this.buffer.toString('utf8', offset + bytesRead, offset + bytesRead + len);
      offset += bytesRead + len;

      if (len === 0) {
        sentences.push(currentSentence);
        currentSentence = [];
      } else {
        currentSentence.push(word);
      }
    }

    if (offset > 0) {
      this.buffer = this.buffer.slice(offset);
    }

    for (const sentence of sentences) {
      this.handleSentence(sentence);
    }
  }

  private handleSentence(words: string[]) {
    if (words.length === 0) return;
    const type = words[0];

    const attributes: Record<string, string> = {};
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      if (word.startsWith('=')) {
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
