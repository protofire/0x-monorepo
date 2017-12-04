#!/usr/bin/env node

import chalk from 'chalk';
import * as fs from 'fs';
import {sync as globSync} from 'glob';
import * as _ from 'lodash';

interface Dependencies {
    [depName: string]: string;
}
interface Versions {
    [packageName: string]: string;
}
interface VersionsByDependency {
    [depName: string]: Versions;
}

function log(...args: any[]) {
    console.log(...args); // tslint:disable-line:no-console
}

function getDependencies(path: string): Dependencies {
    const file = fs.readFileSync(path).toString();
    const parsed = JSON.parse(file);
    const dependencies = {
        ...parsed.dependencies,
        ...parsed.devDependencies,
    };
    return dependencies;
}

function getPackageName(path: string): string {
    const [dotDot, packageName, packageJSON] = path.split('/');
    return packageName;
}

const files = globSync('../*/package.json');
const versionsByDependency: VersionsByDependency = {};
files.map(path => {
    const packageName = getPackageName(path);
    const dependencies = getDependencies(path);
    _.map(dependencies, (version: string, depName: string) => {
        if (_.isUndefined(versionsByDependency[depName])) {
            versionsByDependency[depName] = {};
        }
        versionsByDependency[depName][packageName] = version;
    });
});

_.map(versionsByDependency, (versions: Versions, depName: string) => {
    if (_.uniq(_.values(versions)).length === 1) {
        delete versionsByDependency[depName];
    } else {
        log(chalk.bold(depName));
        _.map(versions, (version: string, packageName: string) => {
            log(`├── ${packageName} -> ${version}`);
        });
    }
});
