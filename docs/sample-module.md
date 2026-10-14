# Sample module

`GET /api/samples?limit=10` demonstrates routes → controller → validation → service → repository → model/type. The repository returns static sample data; no database setup is required. Invalid limits return HTTP 400.

```sh
curl http://localhost:3333/api/samples
curl "http://localhost:3333/api/samples?limit=0"
```

Errors use `{ success: false, error: { code, message, details? } }`; invalid sample queries have code `VALIDATION_ERROR`. See `src/modules/error/README.md`.

Each feature module owns a `<feature>.error.ts` file alongside its controller,
service, repository, model, routes, and validation files. Define errors there
by extending the shared `AppError`; controllers and services import their
module's error classes. `sample.error.ts` defines `SampleValidationError`.
The shared error middleware formats responses for all modules.
