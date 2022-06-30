# Flight log parser plugin for bf blackbox logs
This parser is based on the betaflight blackbox log viewer log parser to handle the intricacies of log format and data frame formats. Huge thanks to the [original authors](https://github.com/betaflight/blackbox-log-viewer/graphs/contributors)! Without them this library won't be possible!

# Main differences between this parser and the original parser.
* Greatly simplified the parsing code by removing the chunked parsing logic, so the whole log will be parsed in one go. Initial parsing time will be longer, but haven't been a real issue so far.
* IMU info calculation removed since it's not accurate anyway and may end up confusing people.
* Ported the code to typescript with a bunch of cleanups and refactor, a lot of places still need types (PRs welcome!).
* Will be a little outdated to read the new configs added in bf 4.3, especially around filters/feedward configurations.
* Added a dozen tests.

# Development
```
git clone git@github.com:dronesitter/bf-blackbox-parser.git
cd bf-blackbox-parser
yarn install
yarn build
```

# All contributions welcome!
Many thanks!