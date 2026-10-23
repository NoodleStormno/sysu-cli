import { homedir } from 'node:os';
import { join } from 'node:path';

export function cliHome() {
  return process.env.SYSU_CLI_HOME || join(homedir(), '.sysu-cli');
}

export function statePath() {
  return join(cliHome(), 'session.json');
}

export function profilesDir() {
  return join(cliHome(), 'profiles');
}

export function capturesDir() {
  return join(cliHome(), 'captures');
}
