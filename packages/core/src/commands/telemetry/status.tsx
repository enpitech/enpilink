import { Command } from "@oclif/core";
import { Box, render, Text } from "ink";

export default class TelemetryStatus extends Command {
  static override description = "Show enpilink telemetry status (always off)";

  public async run(): Promise<void> {
    await this.parse(TelemetryStatus);

    const App = () => (
      <Box flexDirection="column" padding={1}>
        <Text bold underline>
          enpilink Telemetry
        </Text>

        <Box marginTop={1}>
          <Text>Status: </Text>
          <Text color="green" bold>
            Disabled
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text color="gray">
            enpilink has no telemetry. It never collects data and never phones
            home.
          </Text>
        </Box>
      </Box>
    );

    render(<App />);
  }
}
