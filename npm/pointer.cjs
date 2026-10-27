#!/usr/bin/env node
// `npm i -g pathlight` installs @dumbbunnyio/pathlight as its dependency and runs its launcher in this same process, so the launcher's parent is still the shell.
"use strict";
require("@dumbbunnyio/pathlight/launcher.cjs");
