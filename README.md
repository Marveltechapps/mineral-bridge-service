# mineral-bridge-service

Express + TypeScript starter following the structure of `selorg-service` in the Selorg Application reference. Includes a small sample feature demonstrating file and folder conventions.

```sh
npm install
cp .env.example .env
npm run dev
```

Service: http://localhost:3333. Health endpoint: `/api/health`. MongoDB is reserved for future modules; the starter does not connect to a database.

Feature modules go in `src/modules/<feature>/` with `<feature>.controller.ts`, `.service.ts`, `.repository.ts`, `.model.ts`, `.routes.ts`, `.validation.ts`, and `.error.ts`. Each feature owns its error classes, extending the shared `AppError`. Shared code belongs in config, database, middleware, events, realtime, services, types, or utils.

Run `npm run typecheck` to check TypeScript. Dependencies must be installed in this repository first.

## Sample files

The sample feature reads `GET /api/samples` from the service. Start the service before using the sample screens. See `docs/sample-module.md` and the Postman collection for the request contract.
