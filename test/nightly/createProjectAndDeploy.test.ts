/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fse from 'fs-extra';
import { IHookCallbackContext, ISuiteCallbackContext } from 'mocha';
import * as retry from 'p-retry';
import * as vscode from 'vscode';
import { ext, getRandomHexString, isWindows, parseError, ProjectLanguage, requestUtils } from '../../extension.bundle';
import { longRunningTestsEnabled, testUserInput, testWorkspacePath } from '../global.test';
import { getCSharpValidateOptions, getJavaScriptValidateOptions, getPowerShellValidateOptions, getPythonValidateOptions, getTypeScriptValidateOptions, IValidateProjectOptions, validateProject } from '../validateProject';
import { getRotatingAuthLevel, getRotatingLocation } from './getRotatingValue';
import { resourceGroupsToDelete } from './global.nightly.test';

suite('Create Project and Deploy', async function (this: ISuiteCallbackContext): Promise<void> {
    this.timeout(7 * 60 * 1000);

    suiteSetup(async function (this: IHookCallbackContext): Promise<void> {
        if (!longRunningTestsEnabled) {
            this.skip();
        }
    });

    test('JavaScript', async () => {
        await testCreateProjectAndDeploy(getJavaScriptValidateOptions(true), ProjectLanguage.JavaScript);
    });

    test('TypeScript', async () => {
        await testCreateProjectAndDeploy(getTypeScriptValidateOptions(), ProjectLanguage.TypeScript);
    });

    test('CSharp', async () => {
        const namespace: string = 'Company.Function';
        await testCreateProjectAndDeploy(getCSharpValidateOptions('testWorkspace', 'netcoreapp2.1'), ProjectLanguage.CSharp, [namespace]);
    });

    test('PowerShell', async () => {
        await testCreateProjectAndDeploy(getPowerShellValidateOptions(), ProjectLanguage.PowerShell);
    });

    test('Python', async function (this: IHookCallbackContext): Promise<void> {
        // Disabling on Windows until we can get it to work
        if (isWindows) {
            this.skip();
        }

        await testCreateProjectAndDeploy(getPythonValidateOptions(), ProjectLanguage.Python);
    });
});

async function testCreateProjectAndDeploy(validateProjectOptions: IValidateProjectOptions, projectLanguage: ProjectLanguage, languageSpecificInputs: (RegExp | string)[] = []): Promise<void> {
    const functionName: string = 'func' + getRandomHexString(); // function name must start with a letter
    await fse.emptyDir(testWorkspacePath);

    await testUserInput.runWithInputs([testWorkspacePath, projectLanguage, /http\s*trigger/i, functionName, ...languageSpecificInputs, getRotatingAuthLevel()], async () => {
        await vscode.commands.executeCommand('azureFunctions.createNewProject');
    });
    // tslint:disable-next-line: strict-boolean-expressions
    validateProjectOptions.excludedPaths = validateProjectOptions.excludedPaths || [];
    validateProjectOptions.excludedPaths.push('.git'); // Since the workspace is already in a git repo
    await validateProject(testWorkspacePath, validateProjectOptions);

    const appName: string = 'funcBasic' + getRandomHexString();
    resourceGroupsToDelete.push(appName);
    await testUserInput.runWithInputs([/create new function app/i, appName, getRotatingLocation()], async () => {
        await vscode.commands.executeCommand('azureFunctions.deploy');
    });

    await validateFunctionUrl(appName, functionName, projectLanguage);
}

async function copyFunctionUrl(appName: string, functionName: string, projectLanguage: ProjectLanguage): Promise<void> {
    const inputs: (string | RegExp)[] = [appName, functionName];
    if (projectLanguage !== ProjectLanguage.CSharp) { // CSharp doesn't support local project tree view
        inputs.unshift(/^((?!Local Project).)*$/i); // match any item except local project
    }

    await vscode.env.clipboard.writeText(''); // Clear the clipboard
    await testUserInput.runWithInputs(inputs, async () => {
        await vscode.commands.executeCommand('azureFunctions.copyFunctionUrl');
    });
}

async function validateFunctionUrl(appName: string, functionName: string, projectLanguage: ProjectLanguage): Promise<void> {
    // Retry copying the function url a few times because there seems to be a delay between deploying and the function showing up in the list
    const retries: number = 4;
    await retry(
        async (currentAttempt: number) => {
            ext.outputChannel.appendLog(`copyFunctionUrl attempt ${currentAttempt}/${retries + 1}...`);
            if (currentAttempt !== 1) {
                await ext.tree.refresh();
            }

            try {
                await copyFunctionUrl(appName, functionName, projectLanguage);
            } catch (error) {
                // Only retry for errors like "Not all inputs were used: func6c04e44a3a"
                const message: string = parseError(error).message;
                if (message.includes('inputs') && message.includes(functionName)) {
                    throw error;
                } else {
                    throw new retry.AbortError(message);
                }
            }
        },
        { retries, minTimeout: 5 * 1000 }
    );

    const functionUrl: string = await vscode.env.clipboard.readText();

    const request: requestUtils.Request = await requestUtils.getDefaultRequest(functionUrl);
    request.body = { name: "World" };
    request.json = true;
    const response: string = await requestUtils.sendRequest(request);
    assert.ok(response.includes('Hello') && response.includes('World'), 'Expected function response to include "Hello" and "World"');
}
