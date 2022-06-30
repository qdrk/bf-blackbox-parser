import { DataParserPlugin } from "./DataParserPlugin";
import { FlightLog } from "./FlightLog";

class BfLogDataParserPlugin implements DataParserPlugin {
  // A factory method returning a parsed data.
  getParsedData(encodedData) {
    return new FlightLog(encodedData);
  }
}

globalThis["BfLogDataParserPlugin"] = BfLogDataParserPlugin;
