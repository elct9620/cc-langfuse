import { vi } from "vitest";

export const mockObservationEnd = vi.fn();
export const mockObservationUpdate = vi
  .fn()
  .mockReturnValue({ end: mockObservationEnd });

export const mockSpanContext = {
  traceId: "mock-trace-id",
  spanId: "mock-span-id",
  traceFlags: 1,
};

export const mockUpdateTrace = vi.fn();

export const mockStartObservation = vi
  .fn()
  .mockImplementation((_name, _attrs, options) => {
    const asType = options?.asType ?? "span";
    if (asType === "tool") {
      return {
        update: mockObservationUpdate,
        end: mockObservationEnd,
        otelSpan: { spanContext: () => mockSpanContext },
      };
    }
    // generation, agent, span all return the same shape (with updateTrace)
    return {
      end: mockObservationEnd,
      updateTrace: mockUpdateTrace,
      otelSpan: { spanContext: () => mockSpanContext },
    };
  });

export const mockPropagateAttributes = vi
  .fn()
  .mockImplementation(async (_attrs: object, callback: () => Promise<void>) => {
    await callback();
  });

export const mockForceFlush = vi.fn().mockResolvedValue(undefined);

export const mockSdkStart = vi.fn();
export const mockSdkShutdown = vi.fn().mockResolvedValue(undefined);

export function langfuseTracingMock() {
  return {
    startObservation: mockStartObservation,
    propagateAttributes: mockPropagateAttributes,
  };
}

export function langfuseOtelMock() {
  return {
    LangfuseSpanProcessor: vi.fn().mockImplementation(function () {
      return { forceFlush: mockForceFlush };
    }),
  };
}

export function openTelemetryMock() {
  return {
    NodeSDK: vi.fn().mockImplementation(function () {
      return { start: mockSdkStart, shutdown: mockSdkShutdown };
    }),
  };
}
