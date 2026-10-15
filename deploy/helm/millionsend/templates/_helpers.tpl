{{- define "millionsend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "millionsend.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "millionsend.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "millionsend.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "millionsend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "millionsend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "millionsend.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "millionsend.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* The Secret every pod loads, whichever mode produced it. */}}
{{- define "millionsend.secretName" -}}
{{- if eq .Values.secrets.mode "existingSecret" }}
{{- required "secrets.existingSecret.name is required with secrets.mode=existingSecret" .Values.secrets.existingSecret.name }}
{{- else if or (eq .Values.secrets.mode "externalSecret") (eq .Values.secrets.mode "create") }}
{{- include "millionsend.fullname" . }}
{{- else }}
{{- fail (printf "secrets.mode must be existingSecret, externalSecret or create (got %q)" .Values.secrets.mode) }}
{{- end }}
{{- end }}

{{/* image reference: repository@digest, else repository:tag (tag defaults to appVersion). */}}
{{- define "millionsend.imageRef" -}}
{{- $img := .image -}}
{{- if $img.digest }}
{{- printf "%s@%s" $img.repository $img.digest }}
{{- else }}
{{- printf "%s:%s" $img.repository (default .appVersion $img.tag) }}
{{- end }}
{{- end }}

{{- define "millionsend.image" -}}
{{- include "millionsend.imageRef" (dict "image" .Values.image "appVersion" .Chart.AppVersion) }}
{{- end }}

{{/* envFrom shared by every app container: the ConfigMap, then the Secret. */}}
{{- define "millionsend.envFrom" -}}
- configMapRef:
    name: {{ include "millionsend.fullname" . }}
- secretRef:
    name: {{ include "millionsend.secretName" . }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Rolls every pod when the rendered config changes. */}}
{{- define "millionsend.checksums" -}}
checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- if eq .Values.secrets.mode "create" }}
checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
{{- end }}
{{- end }}

{{/* Env, mount and volume for aws.webIdentity; each renders nothing when it is off. */}}
{{- define "millionsend.awsWebIdentityEnv" -}}
{{- $wi := .Values.aws.webIdentity }}
{{- if $wi.enabled }}
- name: AWS_ROLE_ARN
  value: {{ required "aws.webIdentity.roleArn is required with aws.webIdentity.enabled" $wi.roleArn | quote }}
- name: AWS_WEB_IDENTITY_TOKEN_FILE
  value: {{ printf "%s/token" $wi.mountPath | quote }}
- name: AWS_ROLE_SESSION_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
# Tells the app the chain is the credential source (account mail,
# console SES probes), as explicit keys would.
- name: AWS_DEFAULT_CHAIN
  value: "true"
{{- end }}
{{- end }}

{{- define "millionsend.awsWebIdentityVolumeMount" -}}
{{- if .Values.aws.webIdentity.enabled }}
- name: aws-web-identity-token
  mountPath: {{ .Values.aws.webIdentity.mountPath }}
  readOnly: true
{{- end }}
{{- end }}

{{- define "millionsend.awsWebIdentityVolume" -}}
{{- $wi := .Values.aws.webIdentity }}
{{- if $wi.enabled }}
- name: aws-web-identity-token
  projected:
    sources:
      - serviceAccountToken:
          audience: {{ $wi.audience }}
          expirationSeconds: {{ $wi.expirationSeconds }}
          path: token
{{- end }}
{{- end }}

{{/*
Writable paths on a read-only root filesystem: the same set the compose
files mount as tmpfs (Next's runtime caches and the docs' MDX index).
*/}}
{{- define "millionsend.scratchVolumeMounts" -}}
- name: tmp
  mountPath: /tmp
- name: web-next-cache
  mountPath: /app/apps/web/.next/cache
- name: docs-next-cache
  mountPath: /app/apps/docs/.next/cache
- name: docs-source
  mountPath: /app/apps/docs/.source
{{- end }}

{{- define "millionsend.scratchVolumes" -}}
- name: tmp
  emptyDir: {}
- name: web-next-cache
  emptyDir: {}
- name: docs-next-cache
  emptyDir: {}
- name: docs-source
  emptyDir: {}
{{- end }}
