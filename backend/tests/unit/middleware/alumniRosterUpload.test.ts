import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { uploadAlumniRosterCsv } from "../../../src/middleware/alumniRosterUpload";
import { ALUMNI_ROSTER_CSV_LIMITS } from "../../../src/services/alumni/AlumniRosterCsvParser";

function makeApp() {
  const app = express();
  app.post("/upload", uploadAlumniRosterCsv, (req, res) => {
    res.status(200).json({
      success: true,
      data: {
        bytes: req.file?.buffer.length,
        field: req.file?.fieldname,
        mimeType: req.file?.mimetype,
      },
    });
  });
  return app;
}

describe("alumni roster CSV memory upload", () => {
  it("accepts one non-empty roster CSV in memory", async () => {
    const response = await request(makeApp())
      .post("/upload")
      .attach("roster", Buffer.from("email,programName\na@example.com,EMBA\n"), {
        filename: "ROSTER.CSV",
        contentType: "text/csv",
      })
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      data: { bytes: 37, field: "roster", mimeType: "text/csv" },
    });
  });

  it("requires multipart form data and the roster field", async () => {
    const wrongContentType = await request(makeApp())
      .post("/upload")
      .send({ roster: "private.csv" })
      .expect(400);
    expect(wrongContentType.body.code).toBe("ALUMNI_ROSTER_UPLOAD_INVALID");

    const wrongField = await request(makeApp())
      .post("/upload")
      .attach("document", Buffer.from("a,b\n"), {
        filename: "roster.csv",
        contentType: "text/csv",
      })
      .expect(400);
    expect(wrongField.body.code).toBe("ALUMNI_ROSTER_UPLOAD_INVALID");
  });

  it("rejects an empty upload", async () => {
    const response = await request(makeApp())
      .post("/upload")
      .attach("roster", Buffer.alloc(0), {
        filename: "roster.csv",
        contentType: "text/csv",
      })
      .expect(400);

    expect(response.body.code).toBe("ALUMNI_ROSTER_FILE_REQUIRED");
  });

  it("requires both a CSV extension and a reasonable CSV MIME type", async () => {
    const wrongExtension = await request(makeApp())
      .post("/upload")
      .attach("roster", Buffer.from("email,programName\n"), {
        filename: "roster.xlsx",
        contentType: "text/csv",
      })
      .expect(415);
    expect(wrongExtension.body.code).toBe("ALUMNI_ROSTER_FILE_TYPE_INVALID");

    const wrongMime = await request(makeApp())
      .post("/upload")
      .attach("roster", Buffer.from("email,programName\n"), {
        filename: "roster.csv",
        contentType: "application/pdf",
      })
      .expect(415);
    expect(wrongMime.body.code).toBe("ALUMNI_ROSTER_FILE_TYPE_INVALID");
  });

  it("rejects multiple files and text fields", async () => {
    const multiple = await request(makeApp())
      .post("/upload")
      .attach("roster", Buffer.from("email,programName\n"), {
        filename: "one.csv",
        contentType: "text/csv",
      })
      .attach("roster", Buffer.from("email,programName\n"), {
        filename: "two.csv",
        contentType: "text/csv",
      })
      .expect(400);
    expect(multiple.body.code).toBe("ALUMNI_ROSTER_UPLOAD_INVALID");

    const withField = await request(makeApp())
      .post("/upload")
      .field("note", "do-not-store")
      .attach("roster", Buffer.from("email,programName\n"), {
        filename: "roster.csv",
        contentType: "text/csv",
      })
      .expect(400);
    expect(withField.body.code).toBe("ALUMNI_ROSTER_UPLOAD_INVALID");
    expect(JSON.stringify(withField.body)).not.toContain("do-not-store");
  });

  it("maps the 8 MiB limit without echoing Multer details", async () => {
    const response = await request(makeApp())
      .post("/upload")
      .attach(
        "roster",
        Buffer.alloc(ALUMNI_ROSTER_CSV_LIMITS.maxBytes + 1, 97),
        { filename: "roster.csv", contentType: "text/csv" },
      )
      .expect(413);

    expect(response.body).toEqual({
      success: false,
      message: "The roster CSV exceeds the 8 MiB limit.",
      code: "ALUMNI_ROSTER_FILE_TOO_LARGE",
    });
    expect(response.text).not.toContain("LIMIT_FILE_SIZE");
  });
});
