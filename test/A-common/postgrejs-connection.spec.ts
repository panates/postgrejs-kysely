import { expect } from 'expect';
import { CompiledQuery } from 'kysely';
import { MAX_FETCH_COUNT } from '../../src/constants.js';
import { PostgrejsConnection } from '../../src/postgrejs-connection.js';
import { FakeConnection, FakeCursor } from '../_support/fakes.js';

describe('PostgrejsConnection', () => {
  describe('executeQuery()', () => {
    it("should ask for every row, not PostgreJS's truncating default", async () => {
      // The whole reason this dialect can't just call query() with no
      // options: fetchCount defaults to 100 and the rows beyond it are
      // dropped with no error and no flag.
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
      expect(options?.params).toStrictEqual([1, 'x']);
      expect(options?.rowDecoder).toStrictEqual('object');
    });

    it("should default rollbackOnError to false, PostgreSQL's own behaviour", async () => {
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      await connection.executeQuery(CompiledQuery.raw('select 1'));
      expect(fake.queries[0].options?.rollbackOnError).toStrictEqual(false);
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

  describe('connection', () => {
    it('should expose the underlying PostgreJS connection', () => {
      const fake = new FakeConnection();
      const connection = new PostgrejsConnection(fake.asConnection(), {});
      expect(connection.connection).toBe(fake.asConnection());
    });
  });
});
