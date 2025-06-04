/*  main.js  –– UpdatePrioPlugin
 *  ▸ keeps your original priority-aging logic
 *  ▸ NEW: handles weekly-recurring tasks with `daysOfWeek::`
 *  ▸ NEW: streak logic now scans any order of indented metadata
 * ------------------------------------------------------------ */
const { Plugin, Notice } = require('obsidian');

module.exports = class UpdatePrioPlugin extends Plugin {
    async onload() {
        console.log("UpdatePrioPlugin loaded");

        this.registerEvent(
            this.app.workspace.on('layout-ready', async () => {
                try {
                    await this.updatePrio();
                    await this.updateStreaks();
                } catch (err) {
                    console.error("Error in UpdatePrioPlugin:", err);
                    new Notice("Fehler beim Tages-Update – siehe Konsole.");
                }
            })
        );
    }

    /* ---------- 1. PRIORITY UPDATE ------------------------------------ */
    async updatePrio() {
        console.log("Starting updatePrio");
        const moment = window.moment;
        const isoLetter = { 1: 'M', 2: 'T', 3: 'W', 4: 'R', 5: 'F', 6: 'S', 7: 'U' }[moment().isoWeekday()];

        const todoFiles = this.app.vault
            .getMarkdownFiles()
            .filter(f => f.basename.startsWith("ToDo"));

        for (let file of todoFiles) {
            let changed = false;
            let lines = (await this.app.vault.read(file)).split('\n');

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];

                /* ---------- 1A. weekly recurring tasks ---------- */
                if (line.includes('🔁')) {
                    const prioMatch = line.match(/\[🎯:: (\S+?)\]/);
                    if (!prioMatch) continue;

                    let prioStr = prioMatch[1];
                    let j = i + 1;
                    let daysField = null;

                    while (j < lines.length && /^[ \t]+- /.test(lines[j])) {
                        const sub = lines[j].trim();                 // e.g. "- daysOfWeek:: W,S,U"
                        const df = sub.match(/^-+\s*daysOfWeek::\s*([MTRFSWU,]+)/i);
                        if (df) {
                            daysField = df[1].replace(/\s+/g, '');   // "W,S,U"
                            break;
                        }
                        j++;
                    }

                    if (daysField) {                                // weekly rule applies
                        const todayIsOnList = daysField.split(',').includes(isoLetter);
                        const newPrioStr = todayIsOnList ? '1' : '/';

                        if (prioStr !== newPrioStr) {
                            lines[i] = line.replace(/\[🎯:: (\S+?)\]/, `[🎯:: ${newPrioStr}]`);
                            changed = true;
                        }
                        continue;   // skip normal deadline logic
                    }
                }

                /* ---------- 1B. original “deadline” logic ---------- */
                const taskMatch = line.match(/- \[ \] .*?\[🎯:: (\/|\d+)\].*?\[⏳:: (\d{4}-\d{2}-\d{2})\]/);
                if (!taskMatch) continue;

                const prioStr = taskMatch[1];
                const deadlineRaw = taskMatch[2];
                const today = moment().startOf('day');

                /* ----- (i) priority “/” that becomes 1 on the day ----- */
                if (prioStr === "/") {
                    const deadline = moment(deadlineRaw, 'YYYY-MM-DD');
                    if (deadline.isValid() && !today.isBefore(deadline)) {
                        lines[i] = line.replace(/\[🎯:: (\/|\d+)\]/, `[🎯:: 1]`);
                        changed = true;
                    }
                    continue;
                }

                /* ----- (ii) ageing numeric priorities ----- */
                let prio = parseInt(prioStr, 10);
                let startPrio = null;
                let createdDate = null;
                let j = i + 1;

                while (j < lines.length && /^[ \t]+- /.test(lines[j])) {
                    const sub = lines[j].trim();
                    const sp = sub.match(/^start_prio:: (\d+)/);
                    const cd = sub.match(/^created:: (\d{4}-\d{2}-\d{2})/);
                    if (sp) startPrio = parseInt(sp[1], 10);
                    if (cd) createdDate = cd[1];
                    j++;
                }
                if (startPrio === null || createdDate === null) continue;

                const creationMoment = moment(createdDate, 'YYYY-MM-DD');
                const daysSinceCreated = today.diff(creationMoment, 'days');
                let newPrio = Math.max(startPrio - daysSinceCreated, 1);

                const deadlineMoment = moment(deadlineRaw, 'YYYY-MM-DD');
                if (deadlineMoment.isValid() &&
                    deadlineMoment.diff(today, 'days') <= 2) newPrio = 1;

                if (newPrio !== prio) {
                    lines[i] = line.replace(/\[🎯:: (\d+)\]/, `[🎯:: ${newPrio}]`);
                    changed = true;
                }
            } // for-lines

            if (changed) {
                await this.app.vault.modify(file, lines.join('\n'));
                console.log(`Updated priorities in ${file.path}`);
            }
        } // for-files

        new Notice("Prioritäten wurden aktualisiert.");
    }


    /* ---------- 2. STREAK MAINTENANCE -------------------------------- */
    async updateStreaks() {
        console.log("Starting updateStreaks");
        const moment = window.moment;
        const today = moment().startOf('day');
        const yesterday = moment(today).subtract(1, 'day');

        const todoFiles = this.app.vault
            .getMarkdownFiles()
            .filter(f => f.basename.startsWith("ToDo"));

        for (let file of todoFiles) {
            let changed = false;
            let lines = (await this.app.vault.read(file)).split('\n');

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];

                if (!line.includes('🔁')) continue;                 // only repeating
                const cb = line.match(/^(- \[( |x)\])/);
                if (!cb) continue;

                const isChecked = cb[2] === 'x';

                // grab ✅ date if any
                const doneMatch = line.match(/✅ (\d{4}-\d{2}-\d{2})/);
                const doneDate = doneMatch ? moment(doneMatch[1], 'YYYY-MM-DD') : null;

                /* ---- scan indented lines for streak metadata ---- */
                let streak = null;
                let streakIdx = null;
                let streakStart = null;
                let streakStartIdx = null;

                let j = i + 1;
                while (j < lines.length && /^[ \t]+- /.test(lines[j])) {
                    const sub = lines[j].trim();                // e.g. "- streak:: 0"

                    const st = sub.match(/^-+\s*streak::\s*(\d+)/i);
                    if (st) { streak = parseInt(st[1], 10); streakIdx = j; }

                    const ss = sub.match(/^-+\s*streak_start::\s*(\d{4}-\d{2}-\d{2})/i);
                    if (ss) { streakStart = ss[1]; streakStartIdx = j; }

                    j++;
                }

                // skip tasks that do NOT track streaks
                if (streak === null || streakStart === null) continue;

                const streakStartMoment = moment(streakStart, 'YYYY-MM-DD');
                const lastDone = moment(streakStartMoment).add(streak - 1, 'days');

                /* -------- CASE A: task is checked -------- */
                if (isChecked && doneDate) {
                    if (doneDate.isSame(yesterday, 'day')) {
                        streak += 1;
                        lines[streakIdx] = lines[streakIdx].replace(/streak:: \d+/, `streak:: ${streak}`);
                    }
                    else if (doneDate.isBefore(yesterday, 'day')) {
                        streak = 0;
                        streakStart = today.format('YYYY-MM-DD');
                        lines[streakIdx] = lines[streakIdx].replace(/streak:: \d+/, `streak:: 0`);
                        lines[streakStartIdx] = lines[streakStartIdx]
                            .replace(/streak_start:: \d{4}-\d{2}-\d{2}/,
                                `streak_start:: ${streakStart}`);
                    }

                    // uncheck & clear ✅ if not done today
                    if (!doneDate.isSame(today, 'day')) {
                        lines[i] = line.replace('- [x]', '- [ ]').replace(/✅ \d{4}-\d{2}-\d{2}/, '').trimEnd();
                        changed = true;
                    }
                }

                /* -------- CASE B: task is UNchecked -------- */
                if (!isChecked) {
                    const missedDays = yesterday.diff(lastDone, 'days');  // ≥1 ⇒ broken streak
                    if (missedDays >= 1 && streak !== 0) {
                        streak = 0;
                        streakStart = today.format('YYYY-MM-DD');
                        lines[streakIdx] = lines[streakIdx].replace(/streak:: \d+/, `streak:: 0`);
                        lines[streakStartIdx] = lines[streakStartIdx]
                            .replace(/streak_start:: \d{4}-\d{2}-\d{2}/,
                                `streak_start:: ${streakStart}`);
                        changed = true;
                    }
                }
            } // for-lines

            if (changed) {
                await this.app.vault.modify(file, lines.join('\n'));
                console.log(`Updated streaks in ${file.path}`);
            }
        } // for-files

        new Notice("Streaks wurden aktualisiert.");
    }
};
