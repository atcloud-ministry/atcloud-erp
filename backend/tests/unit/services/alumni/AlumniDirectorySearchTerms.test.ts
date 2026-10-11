import { describe, expect, it } from "vitest";
import {
  everyTokenMatch,
  filterSearchTokens,
  freeTextSearchTokens,
  locationSearchTokens,
  wordPrefixRegex,
} from "../../../../src/services/alumni/AlumniDirectorySearchTerms";

describe("AlumniDirectorySearchTerms", () => {
  it("splits input into normalized, accent-insensitive words", () => {
    expect(filterSearchTokens("  Cornell   University ")).toEqual([
      "cornell",
      "university",
    ]);
    expect(filterSearchTokens("Santé Technology")).toEqual(["sante", "technology"]);
    expect(filterSearchTokens("R&D (West)")).toEqual(["r", "d", "west"]);
    expect(filterSearchTokens("cornell Cornell")).toEqual(["cornell"]);
  });

  it("skips lossy symbol-only words such as C++", () => {
    expect(filterSearchTokens("C++")).toEqual([]);
    expect(filterSearchTokens("C# developer")).toEqual(["developer"]);
    expect(filterSearchTokens(".*")).toEqual([]);
  });

  it("drops trailing state and country qualifiers from location searches", () => {
    expect(locationSearchTokens("San Diego, CA")).toEqual(["san", "diego"]);
    expect(locationSearchTokens("San Diego CA")).toEqual(["san", "diego"]);
    expect(locationSearchTokens("San Diego, California, USA")).toEqual([
      "san",
      "diego",
    ]);
    expect(locationSearchTokens("Brooklyn, New York")).toEqual(["brooklyn"]);
    expect(locationSearchTokens("Toronto, ON, Canada")).toEqual(["toronto"]);
    // A qualifier on its own is still the search term.
    expect(locationSearchTokens("New York")).toEqual(["new", "york"]);
    expect(locationSearchTokens("CA")).toEqual(["ca"]);
  });

  it("drops only comma-separated qualifiers from free-text searches", () => {
    expect(freeTextSearchTokens("San Diego, CA")).toEqual(["san", "diego"]);
    expect(freeTextSearchTokens("Seattle, WA, USA")).toEqual(["seattle"]);
    expect(freeTextSearchTokens("Machine Learning AI")).toEqual([
      "machine",
      "learning",
      "ai",
    ]);
    expect(freeTextSearchTokens("Chen, Amy")).toEqual(["chen", "amy"]);
    expect(freeTextSearchTokens("Georgia, US")).toEqual(["georgia"]);
  });

  it("matches tokens at the start of a word only", () => {
    const regex = wordPrefixRegex("corn");
    expect(regex.test("cornell university")).toBe(true);
    expect(regex.test("big cornell")).toBe(true);
    expect(regex.test("popcorn")).toBe(false);
    expect(wordPrefixRegex("c.").test("cx")).toBe(false);
  });

  it("requires every token to match one of the fields", () => {
    expect(everyTokenMatch([], ["a"])).toBeNull();
    expect(everyTokenMatch(["x"], ["a"])).toEqual({ a: wordPrefixRegex("x") });
    expect(everyTokenMatch(["x", "y"], ["a", "b"])).toEqual({
      $and: [
        { $or: [{ a: wordPrefixRegex("x") }, { b: wordPrefixRegex("x") }] },
        { $or: [{ a: wordPrefixRegex("y") }, { b: wordPrefixRegex("y") }] },
      ],
    });
  });
});
