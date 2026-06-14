import { Command } from "@oclif/core";
import { Box, render, Text } from "ink";

export default class TelemetryEnable extends Command {
  static override description = "Telemetry is removed in enpilink (no-op)";

  public async run(): Promise<void> {
    await this.parse(TelemetryEnable);

    const App = () => (
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text color="gray">
            enpilink has no telemetry to enable — nothing is ever collected or
            sent. This command is a no-op.
          </Text>
        </Box>
      </Box>
    );

    render(<App />);
  }
}
