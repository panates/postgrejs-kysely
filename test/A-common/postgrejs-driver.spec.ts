import { expect } from 'expect';
import type { DatabaseConnection } from 'kysely';
import { PostgrejsConnection } from '../../src/postgrejs-connection.js';
import { PostgrejsDialect } from '../../src/postgrejs-dialect.js';
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
    it('should begin a plain transaction as a statement Kysely can see', async () => {
      // Not PostgreJS's startTransaction(): Kysely wraps logging around
      // executeQuery, so a BEGIN sent any other way is invisible to it.
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      await driver.beginTransaction(connection, {});
      expect(fake.queries.map(query => query.sql)).toStrictEqual(['begin']);
      expect(
        fake.calls.some(call => call.method === 'startTransaction'),
      ).toStrictEqual(false);
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

    it('should commit and roll back as statements Kysely can see', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      await driver.commitTransaction(connection);
      await driver.rollbackTransaction(connection);
      expect(fake.queries.map(query => query.sql)).toStrictEqual([
        'commit',
        'rollback',
      ]);
      expect(
        fake.calls.some(
          call => call.method === 'commit' || call.method === 'rollback',
        ),
      ).toStrictEqual(false);
    });

    it('should compile savepoint commands, quoting the name', async () => {
      // PostgreJS's own savepoint(name) would take a different route past
      // Kysely's logging, and would reject any name outside
      // /^[a-zA-Z]\w+$/ - where Kysely, like pg, quotes whatever it is
      // given.
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const { connection, fake } = await acquire(driver);
      const compiler = new PostgrejsDialect({
        pool: pool.asPool(),
      }).createQueryCompiler();
      const compileQuery = compiler.compileQuery.bind(compiler);
      await driver.savepoint(connection, 'a weird "name"', compileQuery);
      await driver.rollbackToSavepoint(connection, 'sp1', compileQuery);
      await driver.releaseSavepoint(connection, 'sp1', compileQuery);
      expect(fake.queries.map(query => query.sql)).toStrictEqual([
        'savepoint "a weird ""name"""',
        'rollback to "sp1"',
        'release "sp1"',
      ]);
      expect(
        fake.calls.some(call => call.method === 'savepoint'),
      ).toStrictEqual(false);
    });

    it('should refuse a connection it did not create', async () => {
      const pool = new FakePool();
      const driver = new PostgrejsDriver({ pool: pool.asPool() });
      await driver.init();
      const foreign = {} as DatabaseConnection;
      await expect(driver.releaseConnection(foreign)).rejects.toThrow(
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
