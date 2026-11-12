import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const {
  VIDEO_BUCKET: bucket, VIDEO_ENDPOINT: endpoint, VIDEO_REGION: region,
  VIDEO_ACCESS_KEY_ID: accessKeyId, VIDEO_SECRET_ACCESS_KEY: secretAccessKey,
  VIDEO_PATH_STYLE: pathStyle
} = process.env;
const forcePathStyle = pathStyle === 'true';
const configured = [bucket, endpoint, region, accessKeyId, secretAccessKey].every(Boolean);
const client = configured ? new S3Client({
  endpoint, region, forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED'
}) : null;

function playbackOrigin() {
  const url = new URL(endpoint);
  if (!forcePathStyle) url.hostname = bucket + '.' + url.hostname;
  return url.origin;
}

export const videoStorage = client ? {
  origin: playbackOrigin(),
  check() {
    return client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(5000) });
  },
  async put(key, stream, size) {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: stream, ContentLength: size, ContentType: 'video/mp4'
    }));
  },
  get(key, abortSignal) {
    return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal });
  },
  url(key, method) {
    const Command = method === 'HEAD' ? HeadObjectCommand : GetObjectCommand;
    return getSignedUrl(client, new Command({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
  }
} : null;
