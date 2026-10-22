import { App } from './ui/app.js';
import { registerCommands } from './ui/commands.js';
import * as NAV from './pdf/nav.js';

const app = new App();
app.navMod = NAV;
registerCommands(app);
app.init();
window.pdfstudio = app; // handy for debugging and automation from the console
