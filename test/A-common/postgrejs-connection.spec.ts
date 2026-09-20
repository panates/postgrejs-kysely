import { expect } from 'expect';
import { CompiledQuery } from 'kysely';
import type { Connection } from 'postgrejs';
import { BindParam, DataTypeOIDs } from 'postgrejs';
import { MAX_FETCH_COUNT } from '../../src/constants.js';
import type { PostgrejsConnectionOptions } from '../../src/postgrejs-connection.js';
import { PostgrejsConnection } from '../../src/postgrejs-connection.js';
import { deferred, FakeConnection, FakeCursor } from '../_support/fakes.js';

/** Hands out fake control connections, and keeps them for inspection. */
class TestConnection extends PostgrejsConnection {
  readonly controlConnections: FakeConnection[] = [];
  protected readonly _controlOptions: { connectGate?: Promise<void> };

  constructor(
    connection: Connection,
    config: PostgrejsConnectionOptions,
    controlOptions: { connectGate?: Promise<void> } = {},
  ) {
    super(connection, config);
    this._controlOptions = controlOptions;
  }

  protected override _createControlConnection(): Connection {
    const control = new FakeConnection();
    control.connectGate = this._controlOptions.connectGate;
    this.controlConnections.push(control);
    return control.asConnection();
  }
}

describe('PostgrejsConnection', () => {
  describe('executeQuery()', () => {
    it('should ask for every row rather than leave the limit unsaid', async () => {
      // Kysely's QueryResult has nowhere to carry PostgreJS's `suspended`,
      // so a result that stopped short would look like a complete one.
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      await connection.executeQuery(CompiledQuery.raw('select 1'));
      expect(fake.queries[0].options?.fetchCount).toStrictEqual(
        MAX_FETCH_COUNT,
      );
    });

    it('should decode rows as objects and pass the compiled parameters through', async () => {
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      await connection.executeQuery(
        CompiledQuery.raw('select * from t where a = $1 and b = $2', [1, 'x']),
      );
      const { sql, options } = fake.queries[0];
      expect(sql).toStrictEqual('select * from t where a = $1 and b = $2');
      expect(
        options?.params?.map((param: BindParam) => param.value),
      ).toStrictEqual([1, 'x']);
      expect(options?.rowDecoder).toStrictEqual('object');
    });

    it("should default rollbackOnError to false, PostgreSQL's own behaviour", async () => {
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      await connection.executeQuery(CompiledQuery.raw('select 1'));
      expect(fake.queries[0].options?.rollbackOnError).toStrictEqual(false);
    });

    it('should pass fetchAsString through, and leave it unset by default', async () => {
      const plain = new FakeConnection();
      await new PostgrejsConnection(plain.asConnection(), {}).executeQuery(
        CompiledQuery.raw('select 1'),
      );
      expect(plain.queries[0].options?.fetchAsString).toBeUndefined();

      const fake = new FakeConnection();
      await new PostgrejsConnection(fake.asConnection(), {
        fetchAsString: [DataTypeOIDs.int8],
      }).executeQuery(CompiledQuery.raw('select 1'));
      expect(fake.queries[0].options?.fetchAsString).toStrictEqual([
        DataTypeOIDs.int8,
      ]);
    });

    it('should let the config override fetchCount, prepare and rollbackOnError', async () => {
      const fake = new FakeConnection();
      const typeMap = {} as any;
      const connection = new PostgrejsConnection(fake.asConnection(), {
        fetchCount: 25,
        prepare: false,
        rollbackOnError: true,
        typeMap,
      });
      await connection.executeQuery(CompiledQuery.raw('select 1'));
      const { options } = fake.queries[0];
      expect(options?.fetchCount).toStrictEqual(25);
      expect(options?.prepare).toStrictEqual(false);
      expect(options?.rollbackOnError).toStrictEqual(true);
      expect(options?.typeMap).toBe(typeMap);
    });

    it('should return an empty array when the statement produced no rows', async () => {
      const fake = new FakeConnection();
      fake.queryResult = { command: 'CREATE' };
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const result = await connection.executeQuery(
        CompiledQuery.raw('create table t (a int)'),
      );
      expect(result.rows).toStrictEqual([]);
      expect(result.numAffectedRows).toBeUndefined();
    });

    it('should report numAffectedRows as a bigint for write commands', async () => {
      for (const command of ['INSERT', 'UPDATE', 'DELETE']) {
        const fake = new FakeConnection();
        fake.queryResult = { command, rows: [], rowsAffected: 3 };
        const connection = new PostgrejsConnection(fake.asConnection(), {});
        const result = await connection.executeQuery(CompiledQuery.raw('...'));
        expect(result.numAffectedRows).toStrictEqual(BigInt(3));
      }
    });

    it('should leave numAffectedRows undefined for a select', async () => {
      const fake = new FakeConnection();
      fake.queryResult = {
        command: 'SELECT',
        rows: [{ a: 1 }],
        rowsAffected: 1,
      };
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const result = await connection.executeQuery(CompiledQuery.raw('...'));
      expect(result.rows).toStrictEqual([{ a: 1 }]);
      expect(result.numAffectedRows).toBeUndefined();
    });

    it('should leave numAffectedRows undefined when the count never arrived', async () => {
      // PostgreJS only fills rowsAffected for INSERT/UPDATE/DELETE, so a
      // MERGE - which Kysely does count - has nothing to report.
      const fake = new FakeConnection();
      fake.queryResult = { command: 'MERGE', rows: [] };
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const result = await connection.executeQuery(CompiledQuery.raw('...'));
      expect(result.numAffectedRows).toBeUndefined();
    });
  });

  describe('streamQuery()', () => {
    it('should open a cursor whose batch size is the chunk size', async () => {
      const fake = new FakeConnection();
      const cursor = new FakeCursor([[{ a: 1 }, { a: 2 }]]);
      fake.queryResult = { command: 'SELECT', rows: [], cursor: cursor as any };
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const chunks: any[] = [];
      for await (const chunk of connection.streamQuery(
        CompiledQuery.raw('select * from t'),
        2,
      )) {
        chunks.push(chunk);
      }
      expect(fake.queries[0].options?.cursor).toStrictEqual(true);
      expect(fake.queries[0].options?.fetchCount).toStrictEqual(2);
      expect(cursor.fetched).toStrictEqual([2, 2]);
      expect(chunks).toStrictEqual([{ rows: [{ a: 1 }, { a: 2 }] }]);
    });

    it('should yield one chunk per batch until the cursor runs out', async () => {
      const fake = new FakeConnection();
      const cursor = new FakeCursor([[{ a: 1 }], [{ a: 2 }], [{ a: 3 }]]);
      fake.queryResult = { command: 'SELECT', rows: [], cursor: cursor as any };
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const rows: any[] = [];
      for await (const chunk of connection.streamQuery(
        CompiledQuery.raw('select * from t'),
        1,
      )) {
        rows.push(...chunk.rows);
      }
      expect(rows).toStrictEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
      expect(cursor.closed).toStrictEqual(true);
    });

    it('should close the cursor when the consumer stops early', async () => {
      const fake = new FakeConnection();
      const cursor = new FakeCursor([[{ a: 1 }], [{ a: 2 }]]);
      fake.queryResult = { command: 'SELECT', rows: [], cursor: cursor as any };
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      for await (const chunk of connection.streamQuery(
        CompiledQuery.raw('select * from t'),
        1,
      )) {
        expect(chunk.rows).toStrictEqual([{ a: 1 }]);
        break;
      }
      expect(cursor.closed).toStrictEqual(true);
    });

    it('should close the cursor when the consumer throws', async () => {
      const fake = new FakeConnection();
      const cursor = new FakeCursor([[{ a: 1 }], [{ a: 2 }]]);
      fake.queryResult = { command: 'SELECT', rows: [], cursor: cursor as any };
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const boom = new Error('consumer failed');
      await expect(
        (async () => {
          for await (const chunk of connection.streamQuery(
            CompiledQuery.raw('select * from t'),
            1,
          )) {
            expect(chunk.rows).toStrictEqual([{ a: 1 }]);
            throw boom;
          }
        })(),
      ).rejects.toThrow(boom);
      expect(cursor.closed).toStrictEqual(true);
    });

    it('should reject a chunk size that is not a positive integer', async () => {
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      for (const chunkSize of [0, -1, 1.5, NaN]) {
        await expect(
          connection
            .streamQuery(CompiledQuery.raw('select 1'), chunkSize)
            .next(),
        ).rejects.toThrow('chunkSize must be a positive integer');
      }
      expect(fake.calls).toStrictEqual([]);
    });
  });

  describe('parameter types', () => {
    async function paramsOf(
      values: unknown[],
      config: PostgrejsConnectionOptions = {},
    ): Promise<any[]> {
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), config);
      await connection.executeQuery(CompiledQuery.raw('select $1', values));
      return fake.queries[0].options?.params as any[];
    }

    it('should leave a value PostgreSQL can resolve itself unspecified', async () => {
      // OID 0 in Parse is what pg sends: the server then types the
      // parameter from where it appears, instead of being told it is a
      // varchar because the value happened to be a JavaScript string.
      const params = await paramsOf(['x', 1, true, 10n, null, undefined]);
      expect(params.map(param => param instanceof BindParam)).toStrictEqual([
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
      expect(params.map(param => param.oid)).toStrictEqual([0, 0, 0, 0, 0, 0]);
      expect(params.map(param => param.value)).toStrictEqual([
        'x',
        1,
        true,
        10n,
        null,
        undefined,
      ]);
    });

    it('should leave values PostgreJS encodes better alone', async () => {
      // A date, a buffer, an array or an object has no text form the
      // server could parse out of context - these keep PostgreJS's typed
      // binary encoding.
      const date = new Date();
      const buffer = Buffer.from([1, 2]);
      const array = [1, 2];
      const object = { a: 1 };
      const params = await paramsOf([date, buffer, array, object]);
      expect(params).toStrictEqual([date, buffer, array, object]);
    });

    it('should declare types again when inferParameterTypes is off', async () => {
      const params = await paramsOf(['x', 1], { inferParameterTypes: false });
      expect(params).toStrictEqual(['x', 1]);
    });
  });

  describe('error stacks', () => {
    it('should append the caller stack to the error', async () => {
      const fake = new FakeConnection();
      const error: any = new Error('boom');
      error.stack = 'Error: boom\n    at the-driver';
      fake.queryResult = error;
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const thrown: any = await connection
        .executeQuery(CompiledQuery.raw('select 1'))
        .catch(e => e);
      expect(thrown).toBe(error);
      expect(thrown.stack).toContain('at the-driver');
      expect(thrown.stack).toContain('postgrejs-connection.spec.ts');
    });

    it('should rethrow something that was never an error unchanged', async () => {
      const fake = new FakeConnection();
      fake.queryResult = () => {
        throw 'a string, thrown';
      };
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const thrown = await connection
        .executeQuery(CompiledQuery.raw('select 1'))
        .catch(e => e);
      expect(thrown).toStrictEqual('a string, thrown');
    });

    it('should leave an error with no stack alone', async () => {
      const fake = new FakeConnection();
      const error: any = new Error('boom');
      error.stack = undefined;
      fake.queryResult = error;
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const thrown = await connection
        .executeQuery(CompiledQuery.raw('select 1'))
        .catch(e => e);
      expect(thrown).toBe(error);
    });
  });

  describe('cancelQuery()', () => {
    it('should cancel the statement the connection is running', async () => {
      const fake = new FakeConnection();
      const gate = deferred();
      fake.queryGate = gate.promise;
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      const pending = connection.executeQuery(
        CompiledQuery.raw('select pg_sleep(60)'),
      );
      await connection.cancelQuery();
      expect(fake.calls.filter(call => call.method === 'cancel')).toHaveLength(
        1,
      );
      gate.resolve();
      await pending;
    });

    it('should do nothing when no statement is in flight', async () => {
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      await connection.cancelQuery();
      await connection.executeQuery(CompiledQuery.raw('select 1'));
      // A cancel after the query settled would reach whatever the
      // connection does next.
      await connection.cancelQuery();
      expect(fake.calls.filter(call => call.method === 'cancel')).toStrictEqual(
        [],
      );
    });
  });

  describe('killSession()', () => {
    it('should terminate the backend from a session of its own', async () => {
      const fake = new FakeConnection(4242);
      const gate = deferred();
      fake.queryGate = gate.promise;
      const connection = new TestConnection(fake.asConnection(), {});
      const pending = connection.executeQuery(
        CompiledQuery.raw('select pg_sleep(60)'),
      );
      await connection.killSession();
      expect(connection.controlConnections).toHaveLength(1);
      const control = connection.controlConnections[0];
      expect(control.calls.map(call => call.method)).toStrictEqual([
        'connect',
        'query',
        'close',
      ]);
      expect(control.queries[0].sql).toStrictEqual(
        'select pg_terminate_backend($1)',
      );
      expect(control.queries[0].options?.params).toStrictEqual([4242]);
      gate.resolve();
      await pending;
    });

    it('should do nothing when no statement is in flight', async () => {
      const fake = new FakeConnection(4242);
      const connection = new TestConnection(fake.asConnection(), {});
      await connection.killSession();
      expect(connection.controlConnections).toStrictEqual([]);
    });

    it('should not kill a backend whose query finished while it was connecting', async () => {
      // Opening the second session takes a moment, and a query that ends
      // in it leaves a connection doing someone else's work - which is
      // what would get terminated.
      const fake = new FakeConnection(4242);
      const queryGate = deferred();
      const connectGate = deferred();
      fake.queryGate = queryGate.promise;
      const connection = new TestConnection(
        fake.asConnection(),
        {},
        {
          connectGate: connectGate.promise,
        },
      );
      const pending = connection.executeQuery(
        CompiledQuery.raw('select pg_sleep(60)'),
      );
      const killing = connection.killSession();
      queryGate.resolve();
      await pending;
      connectGate.resolve();
      await killing;
      const control = connection.controlConnections[0];
      expect(control.calls.map(call => call.method)).toStrictEqual([
        'connect',
        'close',
      ]);
    });
  });

  describe('connection', () => {
    it('should expose the underlying PostgreJS connection', () => {
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      expect(connection.connection).toBe(fake.asConnection());
    });
  });
});
