import { describe, expect, it } from "vitest";
import { parseSrvUsLine, srvUsProvider, srvUsSshArgs } from "./srv-us.js";

describe("parseSrvUsLine", () => {
  it("extracts the URL from srv.us's real on-connect line (live-confirmed format)", () => {
    // Confirmed against a live srv.us tunnel on 2026-06-14: each forwarded port
    // is announced as `<n>: https://<hash>.srv.us/`.
    expect(
      parseSrvUsLine("1: https://65xgxz2werq5kx7rj6fjndeol4.srv.us/"),
    ).toEqual({
      kind: "connected",
      url: "https://65xgxz2werq5kx7rj6fjndeol4.srv.us",
    });
  });

  it("extracts a hash subdomain srv.us URL printed bare", () => {
    expect(
      parseSrvUsLine("https://qp556ma755ktlag5b2xyt334ae.srv.us/"),
    ).toEqual({
      kind: "connected",
      url: "https://qp556ma755ktlag5b2xyt334ae.srv.us",
    });
  });

  it("extracts the URL even when embedded in surrounding text", () => {
    expect(
      parseSrvUsLine("Your service is available at https://abc.srv.us"),
    ).toEqual({
      kind: "connected",
      url: "https://abc.srv.us",
    });
  });

  it("accepts friendly github/gitlab-style subdomains", () => {
    expect(parseSrvUsLine("https://my-user.srv.us/")).toEqual({
      kind: "connected",
      url: "https://my-user.srv.us",
    });
  });

  it("strips a trailing slash", () => {
    expect(parseSrvUsLine("https://abc.srv.us/")).toEqual({
      kind: "connected",
      url: "https://abc.srv.us",
    });
  });

  it("treats non-URL output as a starting/progress message", () => {
    expect(
      parseSrvUsLine("Warning: Permanently added 'srv.us' to known hosts."),
    ).toEqual({
      kind: "starting",
      message: "Warning: Permanently added 'srv.us' to known hosts.",
    });
  });

  it("returns null for blank lines", () => {
    expect(parseSrvUsLine("")).toBeNull();
    expect(parseSrvUsLine("   ")).toBeNull();
  });
});

describe("srvUsSshArgs", () => {
  it("builds the reverse-tunnel ssh argv with hardening options", () => {
    expect(srvUsSshArgs(63189, "/home/u/.enpilink/id_ed25519")).toEqual([
      "-i",
      "/home/u/.enpilink/id_ed25519",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "srv.us",
      "-R",
      "1:localhost:63189",
    ]);
  });
});

describe("srvUsProvider", () => {
  it("is named srv.us and exposes ensure + spawn + parseLine", () => {
    expect(srvUsProvider.name).toBe("srv.us");
    expect(typeof srvUsProvider.ensure).toBe("function");
    expect(typeof srvUsProvider.spawn).toBe("function");
    expect(srvUsProvider.parseLine).toBe(parseSrvUsLine);
  });
});
