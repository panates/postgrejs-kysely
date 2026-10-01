# Changelog

<!-- rman:documented-up-to e9c5b735185fdb6969e2654090b9f4a2ccdda364 -->

## v1.1.1 (2026-09-22)

### 📚 Documentation

- say what each default gives you, not what it guards against (7873de7)

---

## v1.1.0 (2026-09-22)

### 📚 Documentation

- keep the unspecified parameter types, and say what they cost (a160295)

### 🧹 Chores

- update PostgreJS peer and dev dependency to 3.10.0 (50d201e)

---

## v1.0.1 (2026-09-20)

### 📚 Documentation

- the suite passes outright, and the peer floor follows PostgreJS (6b1a2c7)

### 🧹 Chores

- require PostgreJS 3.7 (983fd2b)

---

## v1.0.0 (2026-09-20)

### ✨ Features

- the Kysely dialect itself - dialect, driver, connection (8fee481)
- cancelQuery and killSession, the in-flight abort strategies (f7f31d7)
- run Kysely's own dialect suite, and fix what it found (eced70f)
- pass fetchAsString through, and take the suite down to three (946728a)

### 📚 Documentation

- bring CLAUDE.md in line with the dialect that got built (21d5159)
- record where the suite's last failure goes (5ac2d0a)

### 🧪 Tests

- point the suite's two pg-specific tests at this dialect (7773191)

### 🧹 Chores

- packaging, changelog and a CI job for the dialect suite (89c06d7)
- require PostgreJS 3.6, and stop documenting 3.5 (12d405c)
- update CI to ubuntu-24.04, bump PostgreJS to 3.6.1 (f512831)

### 💬 General Changes

- Initial commit (b53971d)
