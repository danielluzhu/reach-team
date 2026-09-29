# Rental Application

Somebody interested in a home fills in a rental application on their phone,
attaches their ID and proof of income, signs it, and the office gets one PDF.
Runs on **:3200**, separate from the CRM on :3000 and the checklist on :3100.

```
bun run start          # or: bun run dev   (reloads on change)
```

In production it runs as `apply.service` (`systemctl {status,restart} apply`,
`journalctl -u apply`), the same way the checklist runs as `pcc.service`.

| Route                        | What it is                                             |
| ---------------------------- | ------------------------------------------------------ |
| `/`                          | The whole form, four steps; `?property=` fills in the home |
| `/api/terms`                 | Screening notice, certification, lease terms, upload limits |
| `/api/uploads`               | `POST` one document → `{ id, kind, mime, size, name }` |
| `/api/applications`          | `POST` a signed application → `{ receipt, pdf }`       |
| `/copy/:receipt.pdf`         | The applicant's copy, on the link they get at the end  |
| `/applications/:id.pdf`      | The office's copy — only reachable through the CRM's sign-in |
| `/api/health`                | `{ ok: true }`                                         |

## How the public reaches it

This app binds to `127.0.0.1`. The internet reaches the CRM and nothing else, so
the CRM serves the form at **`/apply`** — with no sign-in — and passes requests
on here through an allowlist of the paths above (`applications.ts` in the CRM).
The office copy by id and the uploaded documents are not on that list: a
public visitor can send documents in but never read one back.

The CRM sends `X-Forwarded-Prefix: /apply` and the page stamps it on every path
it asks for (`__BASE__`), exactly as the checklist does under `/checklist`.

The office reads submissions on the CRM's **Applications** tab, which opens
`applications.db` read-only and serves each PDF behind the sign-in. The tab
shows the public link to send out.

## The four steps

1. **The home and you** — property, move-in date, lease term; full name, email,
   phone, date of birth.
2. **History and income** — current address (required) and up to two previous
   ones with landlord contacts; up to three employers; other income.
3. **Household and documents** — other occupants, pets, vehicles, an emergency
   contact, anything else, and documents. Photos are redrawn to 2000px JPEG in
   the browser and every file uploads as it is picked; Continue waits for them.
4. **Review and sign** — a summary with Edit links, the screening notice (must
   be acknowledged), the acknowledgements, the certification (must be ticked)
   and a signature.

Each step is checked before moving on, and everything is checked again on the
server. Everything typed is saved to `localStorage` as it is typed and when the
page goes away, and restored for seven days — except the signature, which has
to be made rather than restored. A restored draft shows file names, not
thumbnails, since uploads are never served back to the public.

## What it stores

`applications.db` holds each application as JSON plus a few columns to list it
by. The signed PDF is written to `pdfs/` at submission — application first, then
each attached photo on a page of its own and each attached PDF page for page —
and that file is what is served afterwards. Delete it and it is rebuilt from the
stored answers on the next request. Uploads live in `uploads/`; ones no
application refers to are deleted at boot after 30 days.

The applicant's copy is addressed by a separate random `receipt`, never by the
id the office's links use.

Submissions are capped at 60 an hour and uploads at 600 an hour across the whole
app — the CRM sees every visitor arrive from the same tunnel, so a per-person
limit isn't possible here.

## What it deliberately doesn't ask

> **Not drafted by a lawyer.** See `legal.ts`.

- **No Social Security number.** The screening provider collects it from the
  applicant directly, so it never sits in this database.
- **No criminal history.** Seattle's Fair Chance Housing Ordinance
  (SMC 14.09) restricts asking; don't add it without an attorney's say-so.
- **A screening notice before signing**, per RCW 59.18.257. The office's actual
  screening criteria belong in `SCREENING_NOTICE`.
