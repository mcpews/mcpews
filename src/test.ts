import {
    AppSession,
    AppSessionConnection,
    ClientConnection,
    CommandFrame,
    CommandResponseFrame,
    EventFrame,
    ServerSession,
    SubscribeFrame,
    UnsubscribeFrame,
    WSApp,
    WSClient,
    WSServer
} from './index';

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
    beforeAll(async () => {
        server = new WSServer(port);
        const callback = jestCallback<[ClientConnection]>();
        server.once('client', callback);
        client = new WSClient(`ws://127.0.0.1:${port}`);
        const clientConn = await callback.haveBeenCalledWith();
        session = clientConn.session;
    });
    afterAll(async () => {
        await delay(100);
        (session as ServerSession | undefined)?.disconnect(true);
        (client as WSClient | undefined)?.disconnect();
        server.close();
    });

    test('send command and respond', async () => {
        const expectedCommand = '/say Hi, there!';
        const expectedResponse = { message: 'Yes! I am here!' };

        const sendCallback = jest.fn<undefined, [CommandFrame]>((frame) => {
            // #2 respond command
            frame.respond(expectedResponse);
        });
        const recvCallback = jestCallback<[CommandResponseFrame]>();
        client.on('command', sendCallback);

        // #1 send command request
        const requestId = session.sendCommand(expectedCommand, recvCallback);

        // #3 receive response
        const response = await recvCallback.haveBeenCalledWith();

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toEqual(expectedCommand);
        expect(sendCallback.mock.calls[0][0].requestId).toEqual(requestId);
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toEqual(requestId);

        client.off('command', sendCallback);
    });

    test('send command respond raw', async () => {
        const expectedCommand = ['/say', 'Hi, there!'];
        const expectedResponse = { message: 'Yes! I am here!' };
        const requestId = 'f4ca4a68-dcf2-461b-bdce-bf699b275336';

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

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toEqual(expectedCommand.join(' '));
        expect(sendCallback.mock.calls[0][0].requestId).toEqual(requestId);
        expect(response.body).toEqual(expectedResponse);
        expect(response.requestId).toEqual(requestId);

        client.off('command', sendCallback);
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

    test('subscribe event raw and publish event (V1)', async () => {
        const eventName = 'TestEventName';
        const expectedFirstEventBody = { firstEvent: 1 };
        const expectedSecondEventBody = { secondEvent: 'hi' };
        const expectedThirdEventBody = { thirdEvent: true };

        const eventListener = jestCallback<[EventFrame]>();
        session.on('event', eventListener);

        // #1 publish event before subscribed
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
});

describe('app server and client', () => {
    let app: WSApp;
    let session: AppSession;
    let client: WSClient;
    beforeAll(async () => {
        app = new WSApp(port);
        const callback = jestCallback<[AppSessionConnection]>();
        app.once('session', callback);
        client = new WSClient(`ws://127.0.0.1:${port}`);
        const clientConn = await callback.haveBeenCalledWith();
        session = clientConn.session;
    });
    afterAll(async () => {
        await delay(100);
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

        expect(sendCallback).toHaveBeenCalledTimes(1);
        expect(sendCallback.mock.calls[0][0].commandLine).toEqual(expectedCommand);
        expect(response.body).toEqual(expectedResponse);

        client.off('command', sendCallback);
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
        await delay(100);
        client.publishEvent(eventName, expectedEventBody);

        const event = await eventPromise;
        expect(event.body).toMatchObject(expectedEventBody);
    });
});
