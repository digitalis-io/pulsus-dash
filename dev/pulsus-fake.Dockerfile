# The PulsusDB stand-in of the dev stack (plan #62 §4.7): cmd/pulsus-fake serving the embedded
# transcripts with the generator on. Built by dev/compose.yaml (service pulsus-fake) and by the CI
# gate ci:fake-image. The golang index digest is pinned like the Postgres images.
FROM golang:1.27.3-alpine3.24@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build
# go.mod's go 1.27.0 line is satisfied; its toolchain line is only a preference.
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /pulsus-fake ./cmd/pulsus-fake

FROM scratch
COPY --from=build /pulsus-fake /pulsus-fake
USER 65534:65534
EXPOSE 9091
ENTRYPOINT ["/pulsus-fake","--listen","0.0.0.0:9091"]
