# CSV import — accounts and contacts

Phase 5 accepts a CSV file of accounts or of contacts and imports it into one
workspace. The import validates every row, applies the deterministic
duplicate policy, and reports what happened to each row.

An imported record is **input the user supplied**. It is not researched,
verified or enriched. See
[ADR 0006](./adr/0006-account-prospect-input.md).

## Import policy

**Row-level partial success.** Each row is validated and persisted on its own,
so a bad row is reported and skipped while the rows around it still land.

- Nothing is inserted blindly.
- Nothing is dropped silently — every row appears in `results[]`.
- `total` always equals `created + updated + skipped + failed`.

## Format

- Comma-separated, first row is the header.
- Header names are matched case- and separator-insensitively: `Company Size`,
  `company_size` and `company-size` are the same column.
- Quoted fields are supported, including embedded commas and escaped quotes
  (`""`).
- `\r\n` line endings and a UTF-8 byte-order mark are handled.
- At most **5,000 data rows** per file. Field sizes are bounded.
- Unknown columns are ignored. A missing required column fails the file with
  `VALIDATION_ERROR`.

### Account columns

| Column           | Required | Notes                                                        |
| ---------------- | -------- | ------------------------------------------------------------ |
| `name`           | **yes**  | The company name as the user knows it.                        |
| `website`        | no       | Absolute URL or bare host; normalized to `https://`.           |
| `domain`         | no       | Derived from `website` when omitted.                           |
| `industry`       | no       | Free text.                                                    |
| `company_size`   | no       | Free text, as the user records it (`120`, `11-50`, …).        |
| `geography`      | no       | Free text.                                                    |
| `description`    | no       | Free text, up to 4,000 characters.                            |
| `revenue_plan_id`| no       | Optional; must be a plan in **this** workspace.               |
| `source_reference`| no      | Your own note for the list, e.g. `q1-target-list.csv`.        |

```csv
name,website,industry,company_size,geography,source_reference
Northwind Trading,https://northwind.example,Wholesale,120,UK,q1-target-list.csv
Initech,https://www.initech.example,Software,9000,US,q1-target-list.csv
```

### Contact columns

| Column            | Required | Notes                                                   |
| ----------------- | -------- | ------------------------------------------------------- |
| `account`         | **yes**  | Account id, or a name that is unique in this workspace. |
| `first_name`      | no       |                                                          |
| `last_name`       | no       | `fullName` is derived from the parts supplied.           |
| `job_title`       | no       |                                                          |
| `email`           | no       | Must be a syntactically valid address.                   |
| `phone`           | no       | Free text, as recorded.                                  |
| `profile_url`     | no       | An `http(s)` URL you already have. It is never fetched.  |
| `source_reference`| no       |                                                          |

A contact needs a first or last name, or an email address.

```csv
account,first_name,last_name,job_title,email,phone
Northwind Trading,Ada,Wong,VP Revenue,ada@northwind.example,+1 555 0100
```

## Validation

CSV rows use the **same** validation as manual entry — there is no weaker
import path. A row fails with a machine-readable `reason` when:

| Reason                   | Cause                                                   |
| ------------------------ | ------------------------------------------------------- |
| `malformed_row`          | The row has more columns than the header, or the file ends inside a quoted field. |
| `invalid`                | A field failed validation; `field` and `message` say which. |
| `missing_account_reference` | A contact row has no `account` value.                |
| `unknown_account`        | The `account` reference resolves to nothing in this workspace. |
| `invalid_plan_reference` | `revenue_plan_id` is not a plan in this workspace.        |
| `storage_error`          | The row could not be persisted.                          |

## Duplicate policy

| Case                                                     | Result                                                |
| -------------------------------------------------------- | ----------------------------------------------------- |
| Account whose normalized domain already exists            | `updated` — only the fields the file supplied change. |
| Two rows in one file with the same domain                 | `skipped`, reason `duplicate_in_file`.                 |
| Contact whose email already exists on that account        | `updated`.                                            |
| Same contact email twice in one file                      | `skipped`, reason `duplicate_in_file`.                |
| Account whose name matches one with a different/no domain | `skipped`, reason `ambiguous_name` — **both records are kept**. |
| Contact on an archived account                            | `skipped`, reason `archived_account`.                  |

A name is never treated as proof that two companies are the same. Resolve an
`ambiguous_name` yourself, by editing one of the records.

## Import result

```json
{
  "total": 4,
  "created": 2,
  "updated": 0,
  "skipped": 0,
  "failed": 2,
  "results": [
    { "row": 2, "status": "created", "id": "…" },
    { "row": 3, "status": "created", "id": "…" },
    {
      "row": 4,
      "status": "failed",
      "reason": "invalid",
      "field": "name",
      "message": "name is required"
    },
    {
      "row": 5,
      "status": "failed",
      "reason": "invalid",
      "field": "website",
      "message": "website must be a valid http(s) URL"
    }
  ]
}
```

`row` is the 1-based line in the file, counting the header, so it matches what
your spreadsheet shows.

## API

```http
POST /accounts/import
{ "csv": "name,website\nNorthwind,https://northwind.example",
  "sourceReference": "q1-target-list.csv",
  "revenuePlanId": "optional-plan-id" }

POST /contacts/import
{ "csv": "account,first_name,email\nNorthwind,Ada,ada@northwind.example",
  "sourceReference": "contacts-q1.csv" }
```

Both require an authenticated session and a workspace the caller belongs to.
The workspace comes from the route; a `workspaceId` or `userId` in the body is
ignored.