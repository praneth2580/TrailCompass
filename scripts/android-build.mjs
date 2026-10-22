#!/usr/bin/env node
import { runGradle } from './android-env.mjs';

const task = process.argv[2] || 'assembleDebug';
runGradle([task]);
