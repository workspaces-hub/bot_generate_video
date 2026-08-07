import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";

/** Nén toàn bộ nội dung sourceDir thành 1 file .zip tại destZipPath. */
export async function zipDirectory(sourceDir: string, destZipPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destZipPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(destZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);
    output.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}
