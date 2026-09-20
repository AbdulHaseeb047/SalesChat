# Manual parity vs Raunaq-POS-System

Use the old app (`D:\Projects\Raunaq-POS-System`) and this app (`D:\Projects\Raunaq-POS`) against the **same** local Postgres if you want identical data. Otherwise seed both and walk the flows.

Shop login: http://localhost:3003/pos/login  
Old shop login: http://localhost:5173/login (or whatever Vite used)

## URL map (old → new)

| Old (Vite) | New (Next.js) |
|---|---|
| `/` | `/pos` |
| `/login` | `/pos/login` |
| `/change-password` | `/pos/change-password` |
| `/sale` | `/pos/sale` |
| `/sales` | `/pos/sales` |
| `/inventory` | `/pos/inventory` |
| `/inventory?stock=low` | `/pos/inventory?stock=low` |
| `/categories` | `/pos/categories` |
| `/brands` | `/pos/brands` |
| `/suppliers` | `/pos/suppliers` |
| `/customers` | `/pos/customers` |
| `/discounts` | `/pos/discounts` |
| `/reports` | `/pos/reports` |
| `/stock-movements` | `/pos/stock-movements` |
| `/staff` | `/pos/staff` |
| `/settings` | `/pos/settings` |
| `/support` | `/pos/support` |
| `/upgrade` | `/pos/upgrade` |
| `/admin` | `/admin` |
| `/admin/clients` | `/admin/clients` |
| `/admin/clients/:id` | `/admin/clients/[tenantId]` |
| `/admin/sales-reps` | `/admin/sales-reps` |
| `/` `/features` `/pricing` `/about` `/contact` (website) | same paths on :3003 |

## Auth

- [ ] Demo shop `owner@demo.shop` lands on `/pos`
- [ ] Super Admin `superadmin@nexmind.com` lands on `/admin`
- [ ] Shop user cannot open `/admin` (redirects to `/pos`)
- [ ] Super Admin cannot open `/pos` (redirects to `/admin`)
- [ ] Wrong password shows an error; session cookies are httpOnly (`pos_access` / `pos_refresh`)
- [ ] Change-password gate still blocks the rest of the app

## Sale (must match old totals)

- [ ] Add products, change qty, line discount, bill discount, tax
- [ ] Cash checkout prints/shows receipt (browser or network printer setting)
- [ ] Credit / udhaar sale creates a customer balance
- [ ] Split payment
- [ ] Hold cart and resume
- [ ] Gift card (if the demo tenant has the feature)
- [ ] Barcode add on the register
- [ ] Feature-locked register redirects to `/pos/upgrade`

## Returns / exchange

- [ ] Open a completed sale from History
- [ ] Partial return with reason; stock comes back
- [ ] Exchange: after return, register opens with customer + credit hint
- [ ] Void sale (permission + reason)

## Udhaar

- [ ] Customer list, create/edit
- [ ] Record a payment; FIFO allocation matches the old app
- [ ] Ledger void/edit (if the plan allows)
- [ ] Print statement / reprint a linked receipt

## Inventory & catalog

- [ ] Product create/edit, stock adjust, low/out filters
- [ ] CSV import/export (if you use it)
- [ ] Categories, brands, suppliers + supplier stock-in slip

## Other shop screens

- [ ] Discounts CRUD and apply on sale
- [ ] Reports + stock movements date range
- [ ] Staff invite + feature checkboxes
- [ ] Settings dialog (business, receipt, password)
- [ ] Support form
- [ ] Plan upgrade page (WhatsApp CTA)

## Platform admin

- [ ] Dashboard counts
- [ ] Create client (trial, plan, features)
- [ ] Client detail: change plan, features, fee status
- [ ] **Revoke access** — shop login blocked; restore works
- [ ] Sales reps list/create

## Receipt print

- [ ] After sale, browser print iframe (or network `printSlip` when settings say NETWORK)
- [ ] History reprint matches the sale that was just made

## Marketing

- [ ] `/` `/features` `/pricing` `/about` `/contact` render
- [ ] Nav Login goes to `/pos/login`

Mark items as you go. Totals, FIFO, and sync apply logic were copied, not rewritten — if a number differs, treat it as a port bug.
