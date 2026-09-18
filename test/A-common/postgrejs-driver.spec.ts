import { expect } from 'expect';
import type { DatabaseConnection } from 'kysely';
import { PostgrejsConnection } from '../../src/postgrejs-connection.js';
import { PostgrejsDriver } from '../../src/postgrejs-driver.js';
import { FakeConnection, FakePool } from '../_support/fakes.js';

/** The connection the driver handed out, and the fake behind it. */
async function acquire(driver: PostgrejsDriver): Promise<{
  connection: DatabaseConnection;
  fake: FakeConnection;
}> {
  const connection = await driver.acquireConnection();
  const fake = (connection as PostgrejsConnection)
    .connection as unknown as FakeConnection;
  return { connection, fake };
}

describe('PostgrejsDriver', () => {
  describe('init()', () => {
    it('should take a pool instance', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      await driver.acquireConnection();
      expect(pool.acquired.length).toStrictEqual(1);
    });

    it('should take a factory, and call it once with the options', async () => {
      const pool = new FakePool();
      const calls: any[] = [];
      const driver = new PostgrejsDriver({
        pool: async options => {
          calls.push(options);
          return pool.asPool();
        },
      });
      const signal = AbortSignal.timeout(10000);
      await driver.init({ signal });
      await driver.acquireConnection();
      await driver.acquireConnection();
      expect(calls).toStrictEqual([{ signal }]);
      expect(pool.acquired.length).toStrictEqual(2);
    });

    it('should refuse to hand out a connection before it is initialized', async () => {
      const driver = new PostgrejsDriver({ pool: new FakePool().asPool() });
      await expect(driver.acquireConnection()).rejects.toThrow(
        'Driver is not initialized',
      );
    });
  });

  describe('acquireConnection()', () => {
    it('should wrap the pooled connection', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const connection = await driver.acquireConnection();
      expect(connection).toBeInstanceOf(PostgrejsConnection);
      expect((connection as PostgrejsConnection).connection).toBe(
        pool.acquired[0].asConnection(),
      );
    });

    it('should run onCreateConnection once per physical connection', async () => {
      // The pool builds a new Connection facade on every acquire, so
      // "already initialized" can only be recognised by backend pid -
      // here the same one comes back twice.
      const pool = new FakePool();
      pool.processIdSequence.push(7, 7, 8);
      const created: number[] = [];
      const driver = new PostgrejsDriver({
        pool: pool.asPool(),
        onCreateConnection: async connection => {
          created.push(
            (connection as PostgrejsConnection).connection.processID!,
          );
        },
      });
      await driver.init();
      await driver.acquireConnection();
      await driver.acquireConnection();
      await driver.acquireConnection();
      expect(created).toStrictEqual([7, 8]);
    });

    it('should run onCreateConnection again after the pool destroyed that connection', async () => {
      const pool = new FakePool();
      pool.processIdSequence.push(7, 7);
      let created = 0;
      const driver = new PostgrejsDriver({
        pool: pool.asPool(),
        onCreateConnection: async () => {
          created++;
        },
      });
      await driver.init();
      await driver.acquireConnection();
      pool.emit('destroy', { processID: 7 });
      await driver.acquireConnection();
      expect(created).toStrictEqual(2);
    });

    it('should run onReserveConnection on every acquire', async () => {
      const pool = new FakePool();
      pool.processIdSequence.push(7, 7);
      const reserved: DatabaseConnection[] = [];
      const driver = new PostgrejsDriver({
        pool: pool.asPool(),
        onReserveConnection: async connection => {
          reserved.push(connection);
        },
      });
      await driver.init();
      const first = await driver.acquireConnection();
      const second = await driver.acquireConnection();
      expect(reserved).toStrictEqual([first, second]);
    });
  });

  describe('transactions', () => {
    it('should begin a plain transaction through PostgreJS', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      await driver.beginTransaction(connection, {});
      expect(fake.calls).toStrictEqual([
        { method: 'startTransaction', args: [] },
      ]);
    });

    it('should spell out a transaction that carries settings', async () => {
      // PostgreJS's startTransaction() only ever sends a bare BEGIN.
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      await driver.beginTransaction(connection, {
        isolationLevel: 'serializable',
        accessMode: 'read only',
      });
      expect(fake.queries[0].sql).toStrictEqual(
        'start transaction isolation level serializable read only',
      );
      expect(
        fake.calls.some(call => call.method === 'startTransaction'),
      ).toStrictEqual(false);
    });

    it('should spell out an isolation level on its own', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      await driver.beginTransaction(connection, {
        isolationLevel: 'repeatable read',
      });
      expect(fake.queries[0].sql).toStrictEqual(
        'start transaction isolation level repeatable read',
      );
    });

    it('should spell out an access mode on its own', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      await driver.beginTransaction(connection, { accessMode: 'read write' });
      expect(fake.queries[0].sql).toStrictEqual('start transaction read write');
    });

    it('should commit and roll back through PostgreJS', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      await driver.commitTransaction(connection);
      await driver.rollbackTransaction(connection);
      expect(fake.calls).toStrictEqual([
        { method: 'commit', args: [] },
        { method: 'rollback', args: [] },
      ]);
    });

    it('should drive savepoints through PostgreJS rather than compiled SQL', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      const compileQuery = () => {
        throw new Error('compileQuery must not be used');
      };
      await driver.savepoint(connection, 'sp1', compileQuery as any);
      await driver.rollbackToSavepoint(connection, 'sp1', compileQuery as any);
      await driver.releaseSavepoint(connection, 'sp1', compileQuery as any);
      expect(fake.calls).toStrictEqual([
        { method: 'savepoint', args: ['sp1'] },
        { method: 'rollbackToSavepoint', args: ['sp1'] },
        { method: 'releaseSavepoint', args: ['sp1'] },
      ]);
    });

    it('should refuse a connection it did not create', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const foreign = {} as DatabaseConnection;
      await expect(driver.commitTransaction(foreign)).rejects.toThrow(
        'Connection was not created by PostgrejsDriver',
      );
    });
  });

  describe('releaseConnection()', () => {
    it('should hand the underlying connection back to the pool', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const connection = await driver.acquireConnection();
      await driver.releaseConnection(connection);
      expect(pool.released).toStrictEqual([pool.acquired[0]]);
    });
  });

  describe('destroy()', () => {
    it('should close the pool once and stop listening to it', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      expect(pool.listenerCount('destroy')).toStrictEqual(1);
      await driver.destroy();
      await driver.destroy();
      expect(pool.closed).toStrictEqual(1);
      expect(pool.listenerCount('destroy')).toStrictEqual(0);
    });

    it('should do nothing when the driver was never initialized', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.destroy();
      expect(pool.closed).toStrictEqual(0);
    });
  });
});
