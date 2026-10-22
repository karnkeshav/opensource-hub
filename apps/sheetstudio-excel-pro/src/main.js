import { App } from './ui/app.js';
import { buildRibbon } from './ui/commands.js';
import './ui/commands-data.js';

const app = new App();
buildRibbon(app);
app.focusSink();
window.sheetstudio = app; // handy for debugging in the console
