export interface DataParserPlugin {
  // A factory method returning a parsed data.
  getParsedData(encodedData);
}
