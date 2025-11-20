import EventEmitter from 'node:events';
import type { WebSocket } from 'ws';
import type { Encryption } from './encrypt.js';
import type { Header, Message } from './protocol.js';
import { Version } from './version.js';

export interface Frame<P extends string = string, B = unknown, H extends Header<P> = Header<P>> {
    session: Session;
    message: Message<B, H>;
    header: H;
    body: B;
    purpose: P;
    requestId: string;
    version: Version;
}

export type Handler<This extends Session = Session, P extends string = string, F extends Frame<P> = Frame<P>> = (
    this: This,
    frame: F,
) => boolean | undefined;

export type ExtendEventMap<
    C extends { new (...args: never[]): unknown },
    EM extends Record<keyof EM, unknown[]>,
> = C extends {
    new (...args: infer Args): infer Inst;
}
    ? Inst extends EventEmitter<infer EventMap>
        ? { new (...args: Args): Inst & EventEmitter<EM & EventMap> }
        : C
    : C;

export interface SessionEvents {
    customFrame: [frame: Frame];
    disconnect: [session: Session];
    encryptionEnabled: [session: Session];
    error: [err: unknown];
    message: [frame: Frame];
}

export class Session extends EventEmitter<SessionEvents> {
    socket: WebSocket;
    version: Version;
    encrypted: boolean;
    encryption: Encryption | null;
    private responserMap: Map<string, Handler>;
    private handlerMap: Map<string, Handler>;

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
                    version,
                };
            } catch (err) {
                this.emit('error', err);
                return;
            }
            this.emit('message', frame);
            const responser = this.responserMap.get(frame.requestId);
            if (responser) {
                let ret: boolean | undefined;
                try {
                    ret = responser.call(this, frame);
                } catch (err) {
                    this.emit('error', err);
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
                    this.emit('error', err);
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
                ...extraHeaders,
            },
            body,
        } satisfies Message);
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
        this.responserMap.set(requestId, responser as Handler);
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
        this.handlerMap.set(purpose, handler as Handler);
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
