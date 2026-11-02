"""SQLite contract tests for finance daily cap predicates in lib/finance-module.js.
Extracts the SQL used by the live API, not a second handwritten query."""
import re
import sqlite3
import unittest
from pathlib import Path

SOURCE = Path("lib/finance-module.js").read_text(encoding="utf-8")


def sql(action, table):
    found = re.search(r'"(' + action + r' ' + table + r'[^"]+)"', SOURCE)
    if found is None:
        raise AssertionError(f"missing {action} {table} in the backend")
    return found.group(1)


INSERT_EXTRA = sql("INSERT INTO", "finance_extras")
INSERT_CALLOUT = sql("INSERT INTO", "finance_callouts")
UPDATE_EXTRA = sql("UPDATE", "finance_extras")
UPDATE_CALLOUT = sql("UPDATE", "finance_callouts")


class FinanceDailyCapTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute(
            "CREATE TABLE finance_extras(id TEXT,organization_id TEXT,employee_id TEXT,"
            "work_date TEXT,task TEXT,amount REAL,created_by TEXT,status TEXT DEFAULT 'pending',"
            "approved_by TEXT,approved_at TEXT)"
        )
        self.db.execute(
            "CREATE TABLE finance_callouts(id TEXT,organization_id TEXT,employee_id TEXT,"
            "work_date TEXT,start_time TEXT,end_time TEXT,duration_minutes INTEGER,"
            "task TEXT,amount REAL,created_by TEXT,status TEXT DEFAULT 'pending',"
            "approved_by TEXT,approved_at TEXT)"
        )

    def extra(self, entry, amount):
        return self.db.execute(
            INSERT_EXTRA,
            (entry, "org_main", "person1", "2026-11-02", "مهمة", amount, "manager",
             "org_main", "person1", "2026-11-02",
             "org_main", "person1", "2026-11-02", amount, 7000),
        ).rowcount

    def callout(self, entry, amount):
        return self.db.execute(
            INSERT_CALLOUT,
            (entry, "org_main", "person1", "2026-11-02", "", "", 120, "استدعاء", amount,
             "manager", "org_main", "person1", "2026-11-02",
             "org_main", "person1", "2026-11-02", amount, 7000),
        ).rowcount

    def decide(self, table, entry, state):
        statement = UPDATE_EXTRA if table == "finance_extras" else UPDATE_CALLOUT
        return self.db.execute(
            statement, (state, "manager", "org_main", entry, state, 7000)
        ).rowcount

    def test_combined_pending_entries_cannot_exceed_cap(self):
        self.assertEqual(self.extra("task1", 4000), 1)
        self.assertEqual(self.callout("call1", 3000), 1)
        self.assertEqual(self.callout("call2", 3000), 0)
        self.assertEqual(self.extra("task2", 3000), 0)
        self.assertEqual(self.decide("finance_extras", "task1", "approved"), 1)
        self.assertEqual(self.decide("finance_callouts", "call1", "approved"), 1)
        self.assertEqual(self.callout("call3", 3000), 0)

    def test_rejected_reservations_free_daily_amount(self):
        self.assertEqual(self.extra("task1", 4000), 1)
        self.assertEqual(self.callout("call1", 3000), 1)
        self.assertEqual(self.decide("finance_callouts", "call1", "rejected"), 1)
        self.assertEqual(self.callout("call2", 3000), 1)

    def test_preexisting_pending_records_still_checked_at_approval(self):
        # Simulate old-stage entries that existed before the cap.
        self.db.execute(
            "INSERT INTO finance_extras(id,organization_id,employee_id,work_date,task,"
            "amount,created_by) VALUES('old1','org_main','person1','2026-11-02','t',6000,'m')"
        )
        self.db.execute(
            "INSERT INTO finance_callouts(id,organization_id,employee_id,work_date,start_time,"
            "end_time,duration_minutes,task,amount,created_by) "
            "VALUES('old2','org_main','person1','2026-11-02','','',120,'c',3000,'m')"
        )
        self.assertEqual(self.decide("finance_extras", "old1", "approved"), 1)
        self.assertEqual(self.decide("finance_callouts", "old2", "approved"), 0)
        self.assertEqual(self.decide("finance_callouts", "old2", "rejected"), 1)


if __name__ == "__main__":
    unittest.main()
