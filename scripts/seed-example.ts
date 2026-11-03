// Creates the SYNTHETIC example protocol (see server/seed.ts) with lineage and demo mapping values. Run with `npm run seed:example`.
import { bootstrap, seedDemo } from '../server/bootstrap.ts';

bootstrap();
console.log(`Created synthetic example protocol ${seedDemo()}`);
