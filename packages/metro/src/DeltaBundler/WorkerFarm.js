/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const chalk = require('chalk');

const {Logger} = require('metro-core');
const Worker = require('jest-worker').default;

import type {TransformResult} from '../DeltaBundler';
import type {WorkerFn, WorkerOptions} from './Worker';
import type {ConfigT} from 'metro-config/src/configTypes.flow';

type WorkerInterface = Worker & {
  transform: WorkerFn,
};

type TransformerResult = {
  result: TransformResult<>,
  sha1: string,
};

class WorkerFarm {
  _worker: WorkerInterface;

  constructor(options: ConfigT) {
    if (options.maxWorkers > 1) {
      this._worker = this._makeFarm(
        options.transformer.workerPath,
        this._computeWorkerKey,
        ['transform'],
        options.maxWorkers,
      );

      this._worker.getStdout().on('data', chunk => {
        options.reporter.update({
          type: 'worker_stdout_chunk',
          chunk: chunk.toString('utf8'),
        });
      });
      this._worker.getStderr().on('data', chunk => {
        options.reporter.update({
          type: 'worker_stderr_chunk',
          chunk: chunk.toString('utf8'),
        });
      });
    } else {
      // eslint-disable-next-line lint/flow-no-fixme
      // $FlowFixMe: Flow doesn't support dynamic requires
      this._worker = require(options.transformer.workerPath);
    }
  }

  kill() {
    if (this._worker && typeof this._worker.end === 'function') {
      this._worker.end();
    }
  }

  async transform(
    filename: string,
    projectRoot: string,
    transformerPath: string,
    options: WorkerOptions,
  ): Promise<TransformerResult> {
    try {
      const data = await this._worker.transform(
        filename,
        projectRoot,
        transformerPath,
        options,
      );

      Logger.log(data.transformFileStartLogEntry);
      Logger.log(data.transformFileEndLogEntry);

      return {
        result: data.result,
        sha1: Buffer.from(data.sha1, 'hex'),
      };
    } catch (err) {
      if (err.loc) {
        throw this._formatBabelError(err, filename);
      } else {
        throw this._formatGenericError(err, filename);
      }
    }
  }

  _makeFarm(workerPath, computeWorkerKey, exposedMethods, numWorkers) {
    const execArgv = process.execArgv.slice();

    // We swallow the first parameter if it's not an option (some things such as
    // flow-node like to add themselves into the execArgv array)
    if (execArgv.length > 0 && execArgv[0].charAt(0) !== '-') {
      execArgv.shift();
    }

    const env = {
      ...process.env,
      // Force color to print syntax highlighted code frames.
      FORCE_COLOR: chalk.supportsColor ? 1 : 0,
    };

    return new Worker(workerPath, {
      computeWorkerKey,
      exposedMethods,
      forkOptions: {env, execArgv},
      numWorkers,
    });
  }

  _computeWorkerKey(method: string, filename: string): ?string {
    // Only when transforming a file we want to stick to the same worker; and
    // we'll shard by file path. If not; we return null, which tells the worker
    // to pick the first available one.
    if (method === 'transform') {
      return filename;
    }

    return null;
  }

  _formatGenericError(err, filename) {
    const error = new TransformError(`${filename}: ${err.message}`);

    return Object.assign(error, {
      stack: (err.stack || '')
        .split('\n')
        .slice(0, -1)
        .join('\n'),
      lineNumber: 0,
    });
  }

  _formatBabelError(err, filename) {
    const error = new TransformError(
      `${err.type || 'Error'}${
        err.message.includes(filename) ? '' : ' in ' + filename
      }: ${err.message}`,
    );

    // $FlowFixMe: extending an error.
    return Object.assign(error, {
      stack: err.stack,
      snippet: err.codeFrame,
      lineNumber: err.loc.line,
      column: err.loc.column,
      filename,
    });
  }
}

class TransformError extends SyntaxError {
  type: string = 'TransformError';

  constructor(message: string) {
    super(message);
    Error.captureStackTrace && Error.captureStackTrace(this, TransformError);
  }
}

module.exports = WorkerFarm;