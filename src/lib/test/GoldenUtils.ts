import { promises as fsp } from 'fs';
import * as os from 'os';
import * as fs from 'fs';

// Where the different non-golden files are stored.
const updatedGoldenDir = `${os.homedir()}/.tmp/ds-flightlog-golden`;

export class GoldenUtils {
  constructor(private fileName, public content) {
    this.rewriteToCanonical(content);
  }

  static async fromFile(directory, fileName) {
    const path = `${directory}/${fileName}`;

    let content = null;
    if (fs.existsSync(path)) {
      const fileContent = await fsp.readFile(path);
      content = JSON.parse(fileContent.toString());
    }

    return new GoldenUtils(fileName, content);
  }

  async diff(actual) {
    this.rewriteToCanonical(actual);

    const equals = this.deepEqual(actual, this.content);

    if (equals) return;

    console.log('Peristing different file.');

    if (!fs.existsSync(updatedGoldenDir)) {
      console.log(`Directory ${updatedGoldenDir} doesn't exist, creating one.`)
      fs.mkdirSync(updatedGoldenDir, { recursive: true });
    }

    await fsp.writeFile(
      `${updatedGoldenDir}/${this.fileName}`, JSON.stringify(actual, null, 2))
  }

  private deepEqual(actual, expected) {
    return JSON.stringify(actual) == JSON.stringify(expected);
  }

  private rewriteToCanonical(content) {
    const isObject = (typeof content == 'object');
    if (!Array.isArray(content) && !isObject) return;

    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; ++ i) {
        if (content[i] === -0) {
          content[i] = 0;
        }

        if (content[i] === null) {
          content[i] = undefined;
        }

        this.rewriteToCanonical(content[i]);
      }
    }

    for (let key in content) {
      this.rewriteToCanonical(content[key]);
    }
    return;
  }
}