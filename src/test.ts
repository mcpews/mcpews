import { randomUUID } from 'crypto';
import {
    AgentActionFrame,
    AgentActionResponseFrame,
    AppSession,
    AppSessionConnection,
    ChatEventFrame,
    ChatEventFrameType,
    ChatSubscribeFrame,
    ChatUnsubscribeFrame,
    ClientConnection,
    ClientError,
    CommandFrame,
    CommandResponseFrame,
    DataFrame,
    DataRequestFrame,
    EncryptRequest,
    EncryptionMode,
    EventFrame,
    LegacyCommandFrame,
    MinecraftAgentActionType,
    MinecraftDataType,
    ServerSession,
    SubscribeFrame,
    UnsubscribeFrame,
    Version,
    WSApp,
    WSClient,
    WSServer
} from './index.js';
import WebSocket from 'ws';
import { pEvent } from 'p-event';

const jest = import.meta.jest;

const delay = <T>(ms: number, value?: T) =>
    new Promise((resolve) =>
        setTimeout(() => {
            resolve(value);
        }, ms)
    );

interface Defer<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}
const defer = <T>() => {
    const ret: Partial<Defer<T>> = {};
    ret.promise = new Promise<T>((resolve, reject) => {
        ret.resolve = resolve;
        ret.reject = reject;
    });
    return ret as Defer<T>;
};

const jestCallback = <Y extends unknown[] = unknown[], T = unknown, C = void>(f?: (this: C, ...args: Y) => T) => {
    let defered = defer<[T, Y, C]>();
    let resolved = false;
    const fn = jest.fn(function (this: C, ...args: Y) {
        const result = f ? f.apply(this, args) : undefined;
        if (!resolved) {
            defered.resolve([result as T, args, this]);
            resolved = true;
        }
        return result;
    });
    const fnModified = fn as typeof fn & {
        haveBeenCalledOnce: () => Promise<T>;
        haveBeenCalledWith: () => Promise<Y[0]>;
        haveBeenCalledWithArguments: () => Promise<Y>;
        haveBeenCalledWithThis: () => Promise<C>;
        clear: () => void;
    };
    fnModified.haveBeenCalledOnce = async () => (await defered.promise)[0];
    fnModified.haveBeenCalledWith = async () => (await defered.promise)[1][0];
    fnModified.haveBeenCalledWithArguments = async () => (await defered.promise)[1];
    fnModified.haveBeenCalledWithThis = async () => (await defered.promise)[2];
    fnModified.clear = () => {
        defered = defer<[T, Y, C]>();
        resolved = false;
    };
    return fnModified;
};

const port = 19134;

describe('basic server and client', () => {
    let server: WSServer;
    let session: ServerSession;
    let client: WSClient;
    beforeEach(async () => {
        server = new WSServer(port);
        const callback = jestCallback<[ClientConnection]>();
        server.once('client', callback);
        client = new WSClient(`ws://127.0.0.1:${port}`);
        const clientConn = await callback.haveBeenCalledWith();
        session = clientConn.session;
        if (session.socket.readyState !== WebSocket.OPEN) {
            await pEvent(session.socket, 'open');
        }
        if (client.socket.readyState !== WebSocket.OPEN) {
            await pEvent(client.socket, 'open');
        }
    });
    afterEach(async () => {
        (session as ServerSession | undefined)?.disconnect(true);
        (client as WSClient | undefined)?.disconnect();
        await new Promise((resolve) => {
            server.close(resolve);
        });
    });

    test('send command and respond', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            // #2 respond command
            if (frame.handleEncryptionHandshake()) {
                return;
            }
            frame.respond(expectedResponse);
        });
        const recvCallback = jestCallback<[CommandResponseFrame]>();
        client.on('command', sendCallback);

        // #1 send command request
        const requestId = session.sendCommand(expectedCommand, recvCallback);

        // #3 receive response
        const response = await recvCallback.haveBeenCalledWith();
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.off('command', sendCallback);
    });

    test('send command respond raw', async () => {
        const expectedCommand = ['/say', 'Hi, there!'];
        const expectedResponse = { message: 'Yes! I am here!' };
        const requestId = randomUUID();

        const sendCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            // #2 respond command
            client.respondCommand(frame.requestId, expectedResponse);
        });
        const recvCallback = jestCallback<[CommandResponseFrame]>();
        client.on('command', sendCallback);
        session.on('commandResponse', recvCallback);

        // #1 send command request
        session.sendCommandRaw(requestId, expectedCommand);

        // #3 receive response
        const response = await recvCallback.haveBeenCalledWith();
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toBe(expectedCommand.join(' '));
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.off('command', sendCallback);
        session.off('commandResponse', recvCallback);
    });

    test('send legacy command and respond', async () => {
        const expectedCommand = 'say';
        const expectedOverload = 'default';
        const expectedInput = { text: 'Hi there!' };
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = jest.fn<undefined, [LegacyCommandFrame]>((frame) => {
            // #2 respond command
            frame.respond(expectedResponse);
        });
        const recvCallback = jestCallback<[CommandResponseFrame]>();
        client.on('commandLegacy', sendCallback);

        // #1 send command request
        const requestId = session.sendCommandLegacy(expectedCommand, expectedOverload, expectedInput, recvCallback);

        // #3 receive response
        const response = await recvCallback.haveBeenCalledWith();
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandName).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].overload).toBe(expectedOverload);
        expect(sendCallback.mock.calls[0][0].input).toEqual(expectedInput);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);
        expect(() => {
            (sendCallback.mock.calls[0][0] as unknown as CommandFrame).handleEncryptionHandshake();
        }).toThrow();

        client.off('commandLegacy', sendCallback);
    });

    test('send legacy command respond raw', async () => {
        const expectedCommand = 'say';
        const expectedOverload = 'default';
        const expectedInput = { text: 'Hi there!' };
        const expectedResponse = { message: 'Yes! I am here!' };
        const requestId = randomUUID();

        const sendCallback = jest.fn<undefined, [LegacyCommandFrame]>((frame) => {
            // #2 respond command
            client.respondCommand(frame.requestId, expectedResponse);
        });
        const recvCallback = jestCallback<[CommandResponseFrame]>();
        client.on('commandLegacy', sendCallback);
        session.on('commandResponse', recvCallback);

        // #1 send command request raw
        session.sendCommandLegacyRaw(requestId, expectedCommand, expectedOverload, expectedInput);

        // #3 receive response
        const response = await recvCallback.haveBeenCalledWith();
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandName).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].overload).toBe(expectedOverload);
        expect(sendCallback.mock.calls[0][0].input).toEqual(expectedInput);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.off('commandLegacy', sendCallback);
        session.off('commandResponse', recvCallback);
    });

    test('subscribe event and send event raw (V1)', async () => {
        const eventName = 'TestEventName';
        const expectedFirstEventBody = { firstEvent: 1 };
        const expectedSecondEventBody = { secondEvent: 'hi' };
        const expectedThirdEventBody = { thirdEvent: true };

        const subscribeCallback = jestCallback<[SubscribeFrame]>();
        const unsubscribeCallback = jestCallback<[UnsubscribeFrame]>();
        const eventListener = jestCallback<[EventFrame]>();
        const eventFilteredListener = jestCallback<[EventFrame]>();
        client.on('subscribe', subscribeCallback);
        client.on('unsubscribe', unsubscribeCallback);
        session.on('event', eventListener);

        // #1 send event before subscribed
        client.sendEvent(eventName, expectedFirstEventBody);
        const firstEvent = await eventListener.haveBeenCalledWith();
        expect(firstEvent.body).toMatchObject(expectedFirstEventBody);
        expect(eventListener).toHaveBeenCalledTimes(1);

        // #2 subscribe event
        session.subscribe(eventName, eventFilteredListener);
        const subscribeFrame = await subscribeCallback.haveBeenCalledWith();
        expect(subscribeFrame.body).toEqual({ eventName });

        // #3 send event after subscribed
        client.sendEvent(eventName, expectedSecondEventBody);
        const secondEvent = await eventFilteredListener.haveBeenCalledWith();
        expect(secondEvent.body).toMatchObject(expectedSecondEventBody);
        expect(eventListener).toHaveBeenCalledTimes(1);
        expect(eventFilteredListener).toHaveBeenCalledTimes(1);

        // #4 unsubscribe event
        session.unsubscribe(eventName, eventFilteredListener);
        const unsubscribeFrame = await unsubscribeCallback.haveBeenCalledWith();
        expect(unsubscribeFrame.body).toEqual({ eventName });

        // #5 send event after unsubscribed
        eventListener.clear();
        client.sendEvent(eventName, expectedThirdEventBody);
        const thirdEvent = await eventListener.haveBeenCalledWith();
        expect(thirdEvent.body).toMatchObject(expectedThirdEventBody);
        expect(eventListener).toHaveBeenCalledTimes(2);
        expect(eventFilteredListener).toHaveBeenCalledTimes(1);

        client.off('subscribe', subscribeCallback);
        client.off('unsubscribe', unsubscribeCallback);
        session.off('event', eventListener);
    });

    test('subscribe event raw and publish event (V2)', async () => {
        const eventName = 'TestEventName';
        const expectedFirstEventBody = { firstEvent: 1 };
        const expectedSecondEventBody = { secondEvent: 'hi' };
        const expectedThirdEventBody = { thirdEvent: true };

        const eventListener = jestCallback<[EventFrame]>();
        session.on('event', eventListener);

        // #1 publish event before subscribed
        client.version = Version.V1_1_0;
        client.publishEvent(eventName, expectedFirstEventBody);
        await delay(100);
        expect(eventListener).toHaveBeenCalledTimes(0);

        // #2 publish event after subscribed
        session.subscribeRaw(eventName);
        await delay(100);
        client.publishEvent(eventName, expectedSecondEventBody);
        const secondEvent = await eventListener.haveBeenCalledWith();
        expect(secondEvent.body).toMatchObject(expectedSecondEventBody);
        expect(eventListener).toHaveBeenCalledTimes(1);

        // #3 publish event after unsubscribed
        session.unsubscribeRaw(eventName);
        await delay(100);
        client.publishEvent(eventName, expectedThirdEventBody);
        await delay(100);
        expect(eventListener).toHaveBeenCalledTimes(1);

        session.off('event', eventListener);
    });

    test('error event', async () => {
        const errorCode = 10001;
        const errorMessage = 'This is a test error message';
        const requestId = randomUUID();

        const errorListener = jestCallback<[ClientError]>();
        session.on('clientError', errorListener);

        // #1 send error
        client.sendError(errorCode, errorMessage, requestId);

        // #2 received error
        const error = await errorListener.haveBeenCalledWith();
        expect(error.statusCode).toBe(errorCode);
        expect(error.statusMessage).toBe(errorMessage);
        expect(error.requestId).toBe(requestId);
        expect(error.frame.requestId).toBe(requestId);
        expect(error.message).toBe(errorMessage);

        session.off('clientError', errorListener);
    });

    test('subscribe chat', async () => {
        const steve = 'Steve';
        const alex = 'Alex';
        const chatMessageFilter = 'hello';
        const chatType = ChatEventFrameType.Say;
        const chatMessage = 'Nice to meet you';

        const chatSubscribeCallback = jestCallback<[ChatSubscribeFrame]>();
        const chatUnsubscribeCallback = jestCallback<[ChatUnsubscribeFrame]>();
        const chatCallback = jestCallback<[ChatEventFrame]>();
        client.on('chatSubscribe', chatSubscribeCallback);
        client.on('chatUnsubscribe', chatUnsubscribeCallback);

        // #1 subscribe chat
        const requestId = session.subscribeChat(steve, alex, chatMessageFilter, chatCallback);
        const chatSubscription = await chatSubscribeCallback.haveBeenCalledWith();
        expect(chatSubscription.sender).toBe(steve);
        expect(chatSubscription.receiver).toBe(alex);
        expect(chatSubscription.chatMessage).toBe(chatMessageFilter);
        expect(chatSubscription.requestId).toBe(requestId);

        // #2 send chat event
        client.sendChat(requestId, chatType, alex, steve, chatMessage);
        const chatEvent = await chatCallback.haveBeenCalledWith();
        expect(chatEvent.sender).toBe(alex);
        expect(chatEvent.receiver).toBe(steve);
        expect(chatEvent.chatMessage).toBe(chatMessage);
        expect(chatEvent.chatType).toBe(chatType);

        // #3 unsubscribe chat
        session.unsubscribeChat(requestId);
        const chatUnsubscription = await chatUnsubscribeCallback.haveBeenCalledWith();
        expect(chatUnsubscription.subscribeRequestId).toBe(requestId);

        // #4 unsubscribe chat all
        chatUnsubscribeCallback.clear();
        session.unsubscribeChatAll();
        const chatUnsubscriptionAll = await chatUnsubscribeCallback.haveBeenCalledWith();
        expect(chatUnsubscriptionAll.subscribeRequestId).toBeUndefined();

        client.off('chatSubscribe', chatSubscribeCallback);
    });

    test('send agent action and respond', async () => {
        const expectedCommand = '/agent test';
        const expectedResponse = { message: 'Yes! I am here!' };
        const expectedAgentAction = { data: 'agent action' };
        const expectedAction = MinecraftAgentActionType.Inspect;
        const expectedActionName = 'inspect';

        const sendCallback = jest.fn<undefined, [AgentActionFrame]>((frame) => {
            // #2 respond command
            frame.respondCommand(expectedResponse);
            frame.respondAgentAction(expectedAction, expectedActionName, expectedAgentAction);
        });
        const recvCallback = jestCallback<[AgentActionResponseFrame]>();
        client.on('agentAction', sendCallback);

        // #1 send command request
        const requestId = session.sendAgentCommand(expectedCommand, recvCallback);

        // #3 receive response
        const response = await recvCallback.haveBeenCalledWith();
        expect(response.body).toEqual(expectedAgentAction);
        expect(response.action).toBe(expectedAction);
        expect(response.actionName).toBe(expectedActionName);
        expect(response.commandResponse).toBeDefined();
        expect(response.commandResponse?.body).toEqual(expectedResponse);
        expect(response.requestId).toBe(requestId);
        expect(response.commandResponse?.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.off('agentAction', sendCallback);
    });

    test('send data request and respond', async () => {
        const dataType = MinecraftDataType.Block;
        const dataResponse = [{ id: 'mcpews:test', aux: 0, name: 'mcpews test' }];

        const sendCallback = jest.fn<undefined, [DataRequestFrame<typeof dataType>]>((frame) => {
            // #2 respond command
            frame.respond(dataResponse);
        });
        const recvCallback = jestCallback<[DataFrame<typeof dataType, typeof dataResponse>]>();
        client.setDataResponser(dataType, sendCallback);

        // #1 send data request
        const requestId = session.fetchData(dataType, recvCallback);

        // #3 receive response
        const response = await recvCallback.haveBeenCalledWith();
        expect(response.body).toEqual(dataResponse);
        expect(response.dataType).toBe(dataType);
        expect(response.requestId).toBe(requestId);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].purpose).toBe(`data:${dataType}`);
        expect(sendCallback.mock.calls[0][0].requestId).toBe(requestId);

        client.clearDataResponser(dataType);
    });

    test('encryption by command', async () => {
        const expectedCommand = '/say This message is encrypted!';
        const expectedResponse = { message: 'Yes! It is encrypted!' };

        const handshakeResults = [] as boolean[];
        const commandCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            // #2 handle encryption handshake
            const handshakeResult = frame.handleEncryptionHandshake();
            handshakeResults.push(handshakeResult);
            if (!handshakeResult) {
                frame.respond(expectedResponse);
            }
        });
        const encryptCallback = jestCallback<[ServerSession]>();
        const commandResponseCallback = jestCallback<[CommandResponseFrame]>();
        client.on('command', commandCallback);

        // #1 send encryption handshake
        const encryptableBefore = session.enableEncryption(encryptCallback);
        expect(encryptableBefore).toBe(true);

        // #3 wait for handshake complete
        await encryptCallback.haveBeenCalledWith();
        expect(session.encryption).toBeTruthy();
        expect(client.encryption).toBeTruthy();

        // #4 check encryptable and other flags
        const encryptableAfter = session.enableEncryption();
        expect(encryptableAfter).toBe(false);
        expect(session.encrypted).toBe(false); // No data transmitted, so assume it is not encrypted yet.
        expect(client.encrypted).toBe(false);
        expect(session.isEncrypted()).toBe(false);
        expect(client.isEncrypted()).toBe(false);

        // #5 transmit data
        session.sendCommand(expectedCommand, commandResponseCallback);
        const commandResponse = await commandResponseCallback.haveBeenCalledWith();
        expect(commandResponse.body).toEqual(expectedResponse);
        expect(session.encrypted).toBe(true);
        expect(client.encrypted).toBe(true);

        expect(commandCallback).toHaveBeenCalledTimes(2);
        expect(commandCallback.mock.calls[0][0].commandLine).toContain('enableencryption');
        expect(commandCallback.mock.calls[1][0].commandLine).toBe(expectedCommand);
        expect(handshakeResults).toEqual([true, false]);

        client.off('command', commandCallback);
    });

    test('encryption by frame (cfb8)', async () => {
        const expectedCommand = '/say This message is encrypted!';
        const expectedResponse = { message: 'Yes! It is encrypted!' };

        const handshakeResults = [] as boolean[];
        const commandCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            // #2 handle encryption handshake
            const handshakeResult = frame.handleEncryptionHandshake();
            handshakeResults.push(handshakeResult);
            if (!handshakeResult) {
                frame.respond(expectedResponse);
            }
        });
        const encryptRequestCallback = jest.fn<undefined, [EncryptRequest]>();
        const encryptCallback = jestCallback<[ServerSession]>();
        const commandResponseCallback = jestCallback<[CommandResponseFrame]>();
        client.on('command', commandCallback);
        client.on('encryptRequest', encryptRequestCallback);

        // #1 send encryption handshake
        session.version = Version.V1_0_0;
        const encryptableBefore = session.enableEncryption(EncryptionMode.Aes256cfb8, encryptCallback);
        expect(encryptableBefore).toBe(true);

        // #2 wait for handshake complete
        await encryptCallback.haveBeenCalledWith();
        expect(session.encryption).toBeTruthy();
        expect(client.encryption).toBeTruthy();

        // #3 transmit data
        session.sendCommand(expectedCommand, commandResponseCallback);
        const commandResponse = await commandResponseCallback.haveBeenCalledWith();
        expect(commandResponse.body).toEqual(expectedResponse);
        expect(session.encrypted).toBe(true);
        expect(client.encrypted).toBe(true);

        expect(encryptRequestCallback).toHaveBeenCalledTimes(1);
        expect(() => {
            encryptRequestCallback.mock.calls[0][0].cancel();
        }).toThrow();
        expect(commandCallback).toHaveBeenCalledTimes(1);
        expect(commandCallback.mock.calls[0][0].commandLine).toEqual(expectedCommand);
        expect(handshakeResults).toEqual([false]);

        client.off('command', commandCallback);
        client.off('encryptRequest', encryptRequestCallback);
    });

    test('encryption by frame (cfb)', async () => {
        const expectedCommand = '/say This message is encrypted!';
        const expectedResponse = { message: 'Yes! It is encrypted!' };

        const handshakeResults = [] as boolean[];
        const commandCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            // #2 handle encryption handshake
            const handshakeResult = frame.handleEncryptionHandshake();
            handshakeResults.push(handshakeResult);
            if (!handshakeResult) {
                frame.respond(expectedResponse);
            }
        });
        const encryptCallback = jestCallback<[ServerSession]>();
        const commandResponseCallback = jestCallback<[CommandResponseFrame]>();
        client.on('command', commandCallback);

        // #1 send encryption handshake
        session.version = Version.V1_0_0;
        const encryptableBefore = session.enableEncryption(EncryptionMode.Aes256cfb, encryptCallback);
        expect(encryptableBefore).toBe(true);

        // #2 wait for handshake complete
        await encryptCallback.haveBeenCalledWith();
        expect(session.encryption).toBeTruthy();
        expect(client.encryption).toBeTruthy();

        // #3 transmit data
        session.sendCommand(expectedCommand, commandResponseCallback);
        const commandResponse = await commandResponseCallback.haveBeenCalledWith();
        expect(commandResponse.body).toEqual(expectedResponse);
        expect(session.encrypted).toBe(true);
        expect(client.encrypted).toBe(true);

        expect(commandCallback).toHaveBeenCalledTimes(1);
        expect(commandCallback.mock.calls[0][0].commandLine).toBe(expectedCommand);
        expect(handshakeResults).toEqual([false]);

        client.off('command', commandCallback);
    });
});

describe('app server and client', () => {
    let app: WSApp;
    let session: AppSession;
    let client: WSClient;
    beforeEach(async () => {
        app = new WSApp(port);
        const callback = jestCallback<[AppSessionConnection]>();
        app.once('session', callback);
        client = new WSClient(`ws://127.0.0.1:${port}`);
        const clientConn = await callback.haveBeenCalledWith();
        session = clientConn.session;
        if (session.session.socket.readyState !== WebSocket.OPEN) {
            await pEvent(session.session.socket, 'open');
        }
        if (client.socket.readyState !== WebSocket.OPEN) {
            await pEvent(client.socket, 'open');
        }
    });
    afterEach(async () => {
        await (session as AppSession | undefined)?.disconnect(true);
        (client as WSClient | undefined)?.disconnect();
        app.close();
    });

    test('send command and respond', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            frame.respond(expectedResponse);
        });
        client.on('command', sendCallback);

        const response = await session.command(expectedCommand);
        expect(response.body).toEqual(expectedResponse);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toBe(expectedCommand);

        client.off('command', sendCallback);
    });

    test('send command and reject', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedError = { statusCode: 2147483648, statusMessage: 'Who are you?' };

        const sendCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            frame.respond(expectedError);
        });
        client.on('command', sendCallback);

        let response: CommandResponseFrame | null = null;
        let responseError: Error | null = null;
        try {
            response = await session.command(expectedCommand);
        } catch (err) {
            responseError = err as Error;
        }
        expect(response).toBeNull();
        expect(responseError?.message).toEqual(expectedError.statusMessage);

        client.off('command', sendCallback);
    });

    test('send command legacy and respond', async () => {
        const expectedCommand = 'say';
        const expectedOverload = 'default';
        const expectedInput = { text: 'Hi there!' };
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = jest.fn<undefined, [LegacyCommandFrame]>((frame) => {
            frame.respond(expectedResponse);
        });
        client.on('commandLegacy', sendCallback);

        const response = await session.commandLegacy(expectedCommand, expectedOverload, expectedInput);
        expect(response.body).toEqual(expectedResponse);

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandName).toBe(expectedCommand);
        expect(sendCallback.mock.calls[0][0].overload).toBe(expectedOverload);
        expect(sendCallback.mock.calls[0][0].input).toEqual(expectedInput);

        client.off('commandLegacy', sendCallback);
    });

    test('subscribe event and unsubscribe', async () => {
        const eventName = 'TestEventName';
        const expectedEventBody = { data: ['something'] };

        const subscribeCallback = jestCallback<[SubscribeFrame]>();
        const unsubscribeCallback = jestCallback<[UnsubscribeFrame]>();
        const eventListener = jestCallback<[EventFrame]>();
        client.on('subscribe', subscribeCallback);
        client.on('unsubscribe', unsubscribeCallback);

        // #1 subscribe event
        session.on(eventName, eventListener);
        const subscribeFrame = await subscribeCallback.haveBeenCalledWith();
        expect(subscribeFrame.body).toEqual({ eventName });

        // #2 send event after subscribed
        client.sendEvent(eventName, expectedEventBody);
        const event = await eventListener.haveBeenCalledWith();
        expect(event.body).toMatchObject(expectedEventBody);

        // #3 unsubscribe event
        session.off(eventName, eventListener);
        const unsubscribeFrame = await unsubscribeCallback.haveBeenCalledWith();
        expect(unsubscribeFrame.body).toEqual({ eventName });
        expect(eventListener).toHaveBeenCalledTimes(1);

        client.off('subscribe', subscribeCallback);
        client.off('unsubscribe', unsubscribeCallback);
    });

    test('wait for event', async () => {
        const eventName = 'TestEventName';
        const expectedEventBody = { data: 'else' };

        const eventPromise = session.waitForEvent(eventName);
        await delay(100); // wait for subscription
        client.publishEvent(eventName, expectedEventBody);

        const event = await eventPromise;
        expect(event.body).toMatchObject(expectedEventBody);
    });

    test('once event', async () => {
        const eventName = 'TestEventName';
        const expectedEventBody = { data: 'once' };

        const eventListener = jestCallback<[EventFrame]>();
        session.once(eventName, eventListener);
        await delay(100); // wait for subscription
        client.publishEvent(eventName, expectedEventBody);
        client.publishEvent(eventName, expectedEventBody);
        await delay(100); // wait for event publishing

        const eventPromise = session.waitForEvent(eventName);
        await delay(100); // wait for subscription
        client.publishEvent(eventName, expectedEventBody);
        await eventPromise;
        expect(eventListener).toHaveBeenCalledTimes(1);
        expect(eventListener.mock.calls[0][0].body).toMatchObject(expectedEventBody);
    });

    test('encryption', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            if (!frame.handleEncryptionHandshake()) {
                frame.respond(expectedResponse);
            }
        });
        client.on('command', sendCallback);

        expect(session.session.encryption).toBeNull();
        expect(client.encryption).toBeNull();
        expect(session.isEncrypted()).toBe(false);

        await session.enableEncryption();
        expect(session.session.encryption).not.toBeNull();
        expect(client.encryption).not.toBeNull();
        expect(session.isEncrypted()).toBe(false);

        const response = await session.command(expectedCommand);
        expect(response.body).toEqual(expectedResponse);
        expect(session.isEncrypted()).toBe(true);

        expect(sendCallback).toHaveBeenCalledTimes(2);
        expect(sendCallback.mock.calls[1][0].commandLine).toBe(expectedCommand);

        client.off('command', sendCallback);
    });
});
