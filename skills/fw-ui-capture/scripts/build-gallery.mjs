#!/usr/bin/env node
// Compatibility entry only. FWV owns validation, image handling and HTML export.
import { main } from './ui-capture.mjs';
await main(['export', ...process.argv.slice(2)]);
