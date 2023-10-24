import EventEmitter from 'events';
import type { WebSocket } from 'ws';
import { Version } from './version.js';
import { Encryption } from './encrypt.js';
import { Header, Message } from './protocol.js';

export interface Frame<P extends string = string, B = unknown, H extends Header<P> = Header<P>> {
    session: Session;
    message: Message<B, H>;
    header: H;
    body: B;
    purpose: P;
    requestId: string;
    version: Version;
}

export type Handler<This extends Session, P extends string = string, F extends Frame<P> = Frame<P>> = (
    this: This,
    frame: F
) => boolean | undefined;

export class Session extends EventEmitter {
    socket: WebSocket;
    version: Version;
    encrypted: boolean;
    encryption: Encryption | null;
    private responserMap: Map<string, Handler<this>>;
    private handlerMap: Map<string, Handler<this>>;

    constructor(socket: WebSocket, version?: Version) {
        super();
        this.socket = socket;
        this.version = version ?? Version.V0_0_1;
        this.encrypted = false;
        this.encryption = null;
        this.responserMap = new Map();
        this.handlerMap = new Map();
        this.socket.on('message', (messageData: string | Buffer) => {
            let decryptedMessageData = messageData;
            let frame: Frame;
            try {
                if (this.encryption) {
                    if (!this.encrypted && !String(messageData).trim().startsWith('{')) {
                        this.encrypted = true;
                    }
                    if (this.encrypted) {
                        decryptedMessageData = this.encryption.decrypt(messageData as Buffer);
                    }
                }
                const message = JSON.parse(String(decryptedMessageData)) as Message;
                const { header, body } = message;
                const { messagePurpose: purpose, requestId, version } = header;
                frame = {
                    session: this,
                    message,
                    header,
                    body,
                    purpose,
                    requestId,
                    version
                };
            } catch (err) {
                this.emit('error', err as Error);
                return;
            }
            this.emit('message', frame);
            const responser = this.responserMap.get(frame.requestId);
            if (responser) {
                let ret: boolean | undefined;
                try {
                    ret = responser.call(this, frame);
                } catch (err) {
                    this.emit('error', err as Error);
                }
                if (typeof ret === 'boolean') {
                    if (ret) {
                        this.responserMap.delete(frame.requestId);
                    }
                    return;
                }
            }
            const handler = this.handlerMap.get(frame.purpose);
            if (handler) {
                let ret: boolean | undefined;
                try {
                    ret = handler.call(this, frame);
                } catch (err) {
                    this.emit('error', err as Error);
                }
                if (typeof ret === 'boolean') {
                    if (ret) {
                        this.handlerMap.delete(frame.purpose);
                    }
                    return;
                }
            }
            this.emit('customFrame', frame);
        });
        this.socket.on('close', () => {
            this.emit('disconnect', this);
        });
    }

    isEncrypted() {
        return this.encrypted;
    }

    sendMessage(message: object) {
        let messageData: string | Buffer = JSON.stringify(message);
        if (this.encryption) {
            messageData = this.encryption.encrypt(messageData);
        }
        this.socket.send(messageData);
    }

    sendFrame(purpose: string, body: unknown, requestId?: string, extraHeaders?: Record<string, unknown>) {
        this.sendMessage({
            header: {
                version: this.version,
                requestId: requestId ?? '00000000-0000-0000-0000-000000000000',
                messagePurpose: purpose,
                ...extraHeaders
            },
            body
        } as Message);
    }

    hasResponser(requestId: string) {
        return this.responserMap.has(requestId);
    }

    /**
     * Do not specify the type of frame in responser if you want to validate the frame.
     */
    setResponser<F extends Frame = Frame>(requestId: string, responser: Handler<this, string, F>) {
        if (this.responserMap.has(requestId)) {
            throw new Error(`Cannot attach responser to request: ${requestId}`);
        }
        this.responserMap.set(requestId, responser as Handler<this>);
    }

    clearResponser(requestId: string) {
        return this.responserMap.delete(requestId);
    }

    hasHandler(purpose: string) {
        return this.handlerMap.has(purpose);
    }

    /**
     * Do not specify the type of frame in handler if you want to validate the frame.
     */
    setHandler<P extends string, F extends Frame<P> = Frame<P>>(purpose: P, handler: Handler<this, P, F>) {
        if (this.handlerMap.has(purpose)) {
            throw new Error(`Cannot attach handler to purpose: ${purpose}`);
        }
        this.handlerMap.set(purpose, handler as Handler<this>);
    }

    clearHandler(purpose: string) {
        return this.handlerMap.delete(purpose);
    }

    setEncryption(encryption: Encryption | null) {
        this.encryption = encryption;
        if (encryption) {
            this.emit('encryptionEnabled', this);
        }
    }
}

/*
Quick replacement for event listeners
- From:
\s*(\w+):\s*(\((.+)\)\s*=>\s*.+?);
- To:
on(eventName: "$1", listener: $2): this;
once(eventName: "$1", listener: $2): this;
off(eventName: "$1", listener: $2): this;
addListener(eventName: "$1", listener: $2): this;
removeListener(eventName: "$1", listener: $2): this;
emit(eventName: "$1", $3): boolean;
*/

export interface SessionEventMap {
    customFrame: (frame: Frame) => void;
    disconnect: (session: this) => void;
    encryptionEnabled: (session: this) => void;
    error: (err: Error) => void;
    message: (frame: Frame) => void;
}

/* eslint-disable */
export interface Session extends EventEmitter {
    on(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    once(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    off(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    addListener(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    removeListener(eventName: 'customFrame', listener: (frame: Frame) => void): this;
    emit(eventName: 'customFrame', frame: Frame): boolean;
    on(eventName: 'disconnect', listener: (session: this) => void): this;
    once(eventName: 'disconnect', listener: (session: this) => void): this;
    off(eventName: 'disconnect', listener: (session: this) => void): this;
    addListener(eventName: 'disconnect', listener: (session: this) => void): this;
    removeListener(eventName: 'disconnect', listener: (session: this) => void): this;
    emit(eventName: 'disconnect', session: this): boolean;
    on(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    once(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    off(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    addListener(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    removeListener(eventName: 'encryptionEnabled', listener: (session: this) => void): this;
    emit(eventName: 'encryptionEnabled', session: this): boolean;
    on(eventName: 'error', listener: (err: Error) => void): this;
    once(eventName: 'error', listener: (err: Error) => void): this;
    off(eventName: 'error', listener: (err: Error) => void): this;
    addListener(eventName: 'error', listener: (err: Error) => void): this;
    removeListener(eventName: 'error', listener: (err: Error) => void): this;
    emit(eventName: 'error', err: Error): boolean;
    on(eventName: 'message', listener: (frame: Frame) => void): this;
    once(eventName: 'message', listener: (frame: Frame) => void): this;
    off(eventName: 'message', listener: (frame: Frame) => void): this;
    addListener(eventName: 'message', listener: (frame: Frame) => void): this;
    removeListener(eventName: 'message', listener: (frame: Frame) => void): this;
    emit(eventName: 'message', frame: Frame): boolean;
}
/* eslint-enable */
