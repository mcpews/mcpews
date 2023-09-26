import { WebSocket } from 'ws';
import { Version } from './version.js';
import { Frame, Session, SessionEventMap } from './base.js';
import { ClientEncryption } from './encrypt.js';
import {
    CommandRequestBody,
    CommandRequestLegacyBody,
    EncryptionMode,
    EventSubscriptionBody,
    RequestPurpose
} from './protocol.js';

export type CommandFrameBase = Frame<RequestPurpose.Command, CommandRequestBody>;
export interface CommandFrame extends CommandFrameBase {
    commandLine: string;
    respond(body: unknown): void;
    handleEncryptionHandshake(): boolean;
}

export type LegacyCommandFrameBase = Frame<RequestPurpose.Command, CommandRequestLegacyBody>;
interface LegacyCommandFrame extends LegacyCommandFrameBase {
    commandName: string;
    overload: string;
    input: Record<string, unknown>;
    respond(body: unknown): void;
}

export type EventSubscribeFrameBase = Frame<RequestPurpose.Subscribe, EventSubscriptionBody>;
export interface SubscribeFrame extends EventSubscribeFrameBase {
    eventName: string;
}

export type EventUnsubscribeFrameBase = Frame<RequestPurpose.Unsubscribe, EventSubscriptionBody>;
export interface UnsubscribeFrame extends EventUnsubscribeFrameBase {
    eventName: string;
}

export class WSClient extends Session {
    private eventListenMap: Map<string, boolean>;

    constructor(address: string, version?: Version) {
        super(new WebSocket(address), version);
        this.eventListenMap = new Map();
        this.setHandler(RequestPurpose.Subscribe, (frame: EventSubscribeFrameBase): undefined => {
            const { eventName } = frame.body;
            const isEventListening = this.eventListenMap.get(eventName);
            if (!isEventListening) {
                this.emit('subscribe', {
                    ...frame,
                    eventName
                } as SubscribeFrame);
                this.eventListenMap.set(eventName, true);
            }
        });
        this.setHandler(RequestPurpose.Unsubscribe, (frame: EventUnsubscribeFrameBase): undefined => {
            const { eventName } = frame.body;
            const isEventListening = this.eventListenMap.get(eventName);
            if (isEventListening) {
                this.emit('unsubscribe', {
                    ...frame,
                    eventName
                } as UnsubscribeFrame);
                this.eventListenMap.set(eventName, false);
            }
        });
        this.setHandler(RequestPurpose.Command, (frame): undefined => {
            const { requestId, body } = frame;
            const respond = (body: unknown) => {
                this.respondCommand(requestId, body);
            };
            if ((body as CommandRequestBody).commandLine) {
                const handleEncryptionHandshake = () => this.handleEncryptionHandshake(frame.requestId, commandLine);
                const { commandLine } = body as CommandRequestBody;
                this.emit('command', {
                    ...frame,
                    commandLine,
                    respond,
                    handleEncryptionHandshake
                } as CommandFrame);
            } else {
                const { name, overload, input } = body as CommandRequestLegacyBody;
                this.emit('commandLegacy', {
                    ...frame,
                    commandName: name,
                    overload,
                    input,
                    respond,
                    handleEncryptionHandshake: () => {
                        throw new Error('Not supported');
                    }
                } as LegacyCommandFrame);
            }
        });
    }

    handleEncryptionHandshake(requestId: string, commandLine: string) {
        if (commandLine.startsWith('enableencryption ')) {
            const encryption = new ClientEncryption();
            const keyExchangeParams = encryption.beginKeyExchange();
            const args = commandLine.split(' ');
            const mode = (args[3] as EncryptionMode | undefined) ?? EncryptionMode.Aes256cfb8;
            encryption.completeKeyExchange(mode, JSON.parse(args[1]) as string, JSON.parse(args[2]) as string);
            this.respondCommand(requestId, {
                publicKey: keyExchangeParams.publicKey,
                statusCode: 0
            });
            this.setEncryption(encryption);
            return true;
        }
        return false;
    }

    sendError(statusCode?: number, statusMessage?: string, requestId?: string) {
        this.sendFrame(
            'error',
            {
                statusCode,
                statusMessage
            },
            requestId
        );
    }

    sendEvent(eventName: string, body: Record<string, unknown>) {
        if (this.version >= Version.V1_1_0) {
            this.sendFrame('event', body, undefined, { eventName });
        } else {
            this.sendFrame('event', {
                ...body,
                eventName
            });
        }
    }

    publishEvent(eventName: string, body: Record<string, unknown>) {
        const isEventListening = this.eventListenMap.get(eventName);
        if (isEventListening) {
            this.sendEvent(eventName, body);
        }
    }

    respondCommand(requestId: string, body: unknown) {
        this.sendFrame('commandResponse', body, requestId);
    }

    disconnect() {
        this.socket.close();
    }
}

export interface WSClientEventMap extends SessionEventMap {
    subscribe: (event: SubscribeFrame) => void;
    unsubscribe: (event: UnsubscribeFrame) => void;
    command: (event: CommandFrame) => void;
    commandLegacy: (event: LegacyCommandFrame) => void;
}

/* eslint-disable */
export interface WSClient {
    on(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    once(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    off(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    addListener(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    removeListener(eventName: 'subscribe', listener: (event: SubscribeFrame) => void): this;
    emit(eventName: 'subscribe', event: SubscribeFrame): boolean;
    on(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    once(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    off(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    addListener(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    removeListener(eventName: 'unsubscribe', listener: (event: UnsubscribeFrame) => void): this;
    emit(eventName: 'unsubscribe', event: UnsubscribeFrame): boolean;
    on(eventName: 'command', listener: (event: CommandFrame) => void): this;
    once(eventName: 'command', listener: (event: CommandFrame) => void): this;
    off(eventName: 'command', listener: (event: CommandFrame) => void): this;
    addListener(eventName: 'command', listener: (event: CommandFrame) => void): this;
    removeListener(eventName: 'command', listener: (event: CommandFrame) => void): this;
    emit(eventName: 'command', event: CommandFrame): boolean;
    on(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    once(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    off(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    addListener(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    removeListener(eventName: 'commandLegacy', listener: (event: LegacyCommandFrame) => void): this;
    emit(eventName: 'commandLegacy', event: LegacyCommandFrame): boolean;

    // Inherit from Session
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
