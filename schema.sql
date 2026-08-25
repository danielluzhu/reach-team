CREATE TABLE tenants (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    email           TEXT,
    phone           TEXT,
    property_address TEXT,
    unit            TEXT,
    lease_start     DATE,
    lease_end       DATE,
    rent_amount     REAL,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'past', 'pending', 'vacant', 'rented')),
    notes           TEXT,
    -- Door codes from the Home/Unit Information doc. access_code is the unit's
    -- own code; building_code is shared by every unit in that building.
    access_code     TEXT,
    building_code   TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Spreadsheet-style grids (imported from Google Sheets, edited in the browser).
-- Columns/rows are stored as JSON documents so the grid can stay free-form.
CREATE TABLE IF NOT EXISTS sheets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    columns     TEXT NOT NULL,
    rows        TEXT NOT NULL,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Bumped on every save. A page sends back the rev it loaded, and a save
    -- carrying a stale one is refused rather than applied — see db.ts.
    rev         INTEGER NOT NULL DEFAULT 1
);
