# Database Schema Documentation

Canonical Mongoose models under `src/modules/**` and `src/models/`.

## Identity / auth

`users`, `otpchallenges`, `otpsendlogs`, `customersessions`, `staffusers`, `staffsessions`

## Trading

`orders` (workflow + timeline + sell payload), `quotations`, `contracts`, `payments`, `payouts`, `inspections`, `shipments`, `refunds`

## Catalogue / cart / files

`categories`, mineral types, `products`, `carts`, `fileobjects` (`FileObject`)

## Comms

`notifications`, devices, prefs, `supporttickets`, `outboxevents`

## Rules

- Money: integer `amountMinor`
- Soft delete on users
- Do not drop production collections
