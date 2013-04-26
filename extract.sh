#!/bin/sh

SYNTAX="$0 from to"

FROM=$1
TO=$2

if [ "$FROM" = "" ]; then
  echo $SYNTAX
  exit 1
fi

if [ "$TO" = "" ]; then
  echo $SYNTAX
  exit 1
fi

if [ ! -d "$FROM" ]; then
  echo "From does not exists : $FROM"
  exit 1
fi

if [ -d "$TO" ]; then
  echo "Destination exists : $TO"
  exit 1
fi

mkdir_p() {
  if ! mkdir -p $1; then
    echo "Unable to create directory $1"
    exit 2
  fi
}

echo "Extracting files from $FROM to $TO"
mkdir_p $TO
TARGET=$(cd $TO && pwd)

cd $FROM

find . -name "200" | while read i; do
  FILE=$(dirname $i | perl -pe 's/^\.\/(.*)$/\1/')
  echo "Processing $FILE"
  mkdir_p "$(dirname $TARGET/$FILE)"
  cp $i "$TARGET/$FILE"
done

echo "Done."