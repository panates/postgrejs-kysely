import { expect } from 'expect';
import * as api from '../../src/index.js';

/**
 * The export surface is part of the contract: a MikroORM driver builds on
 * this package by handing the dialect straight to Kysely, so nothing it
 * needs may be reachable only through a deep import.
 */
describe('package exports', () => {
  it('should export the dialect, driver, connection and constants', () => {
    expect(Object.keys(api).sort()).toStrictEqual([
      'MAX_FETCH_COUNT',
      'PostgrejsConnection',
      'PostgrejsDialect',
      'PostgrejsDriver',
    ]);
  });

  it("should build a dialect whose parts are PostgreSQL's", () => {
    const dialect = new api.PostgrejsDialect({ pool: {} as any });
    expect(dialect.createDriver()).toBeInstanceOf(api.PostgrejsDriver);
    expect(dialect.createAdapter().supportsReturning).toStrictEqual(true);
    expect(dialect.createQueryCompiler()).toBeDefined();
  });
});
